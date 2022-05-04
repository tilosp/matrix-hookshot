
import { MessageQueue, MessageQueueMessage, DEFAULT_RES_TIMEOUT, MessageQueueMessageOut } from "./Types";
import { Redis, default as redis } from "ioredis";
import { BridgeConfig, BridgeConfigQueue } from "../Config/Config";
import { EventEmitter } from "events";
import LogWrapper from "../LogWrapper";

import {v4 as uuid} from "uuid";

const log = new LogWrapper("RedisMq");

const CONSUMER_TRACK_PREFIX = "consumers.";

export class RedisMQ extends EventEmitter implements MessageQueue {

    private static removePartsFromEventName(evName: string, partCount: number) {
        return evName.split(".").slice(0, -partCount).join(".");
    }

    private redisSub: Redis;
    private redisPub: Redis;
    private redis: Redis;
    private myUuid: string;
    constructor(config: BridgeConfigQueue) {
        super();
        this.redisSub = new redis(config.port, config.host);
        this.redisPub = new redis(config.port, config.host);
        this.redis = new redis(config.port, config.host);
        this.myUuid = uuid();
        this.redisSub.on("pmessage", (_: string, channel: string, message: string) => {
            const msg = JSON.parse(message) as MessageQueueMessageOut<unknown>;
            if (msg.for && msg.for !== this.myUuid) {
                log.debug(`Got message for ${msg.for}, dropping`);
                return;
            }
            const delay = (process.hrtime()[1]) - msg.ts;
            log.debug("Delay: ", delay / 1000000, "ms");
            this.emit(channel, JSON.parse(message));
        });
    }

    public subscribe(eventGlob: string) {
        this.redisSub.psubscribe(eventGlob);
        const consumerName = eventGlob.endsWith("*") ? RedisMQ.removePartsFromEventName(eventGlob, 1) : eventGlob;
        this.redis.sadd(`${CONSUMER_TRACK_PREFIX}${consumerName}`, this.myUuid);
    }

    public unsubscribe(eventGlob: string) {
        this.redisSub.punsubscribe(eventGlob);
        this.redis.srem(`${CONSUMER_TRACK_PREFIX}${eventGlob}`, this.myUuid);
    }

    public async push<T>(message: MessageQueueMessage<T>, single = false) {
        if (!message.messageId) {
            message.messageId = uuid();
        }
        if (single) {
            const recipient = await this.getRecipientForEvent(message.eventName);
            if (!recipient) {
                throw Error("Cannot find recipient for event");
            }
            message.for = recipient;
        }
        const outMsg: MessageQueueMessageOut<T> = {
            ...message,
            ts: process.hrtime()[1],
        }
        try {
            await this.redisPub.publish(message.eventName, JSON.stringify(outMsg));
            log.debug(`Pushed ${message.eventName}`);
        } catch (ex) {
            log.warn("Failed to push an event:", ex);
            throw Error("Failed to push message into queue");
        }
    }

    public async pushWait<T, X>(message: MessageQueueMessage<T>,
                                timeout: number = DEFAULT_RES_TIMEOUT): Promise<X> {
        let resolve: (value: X) => void;
        let timer: NodeJS.Timer;

        const p = new Promise<X>((res, rej) => {
            resolve = res;
            timer = setTimeout(() => {
                rej(new Error("Timeout waiting for message queue response"));
                }, timeout);
        });

        const awaitResponse = (response: MessageQueueMessage<X>) => {
            if (response.messageId === message.messageId) {
                clearTimeout(timer);
                this.removeListener(`response.${message.eventName}`, awaitResponse);
                resolve(response.data);
            }
        };

        this.addListener(`response.${message.eventName}`, awaitResponse);
        await this.push(message);
        return p;
    }

    public stop() {
        this.redisPub.disconnect();
        this.redisSub.disconnect();
    }

    private async getRecipientForEvent(eventName: string): Promise<string|null> {
        let recipient = null;
        let parts = 0;
        const totalParts = eventName.split(".").length;
        // Work backwards from the event name.
        while (recipient === null && parts < totalParts) {
            const evName = RedisMQ.removePartsFromEventName(eventName, parts);
            recipient = await this.redis.srandmember(evName) || null;
            parts++;
        }
        return recipient;
    }
}
