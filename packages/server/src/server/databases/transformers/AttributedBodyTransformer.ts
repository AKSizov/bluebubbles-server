import { Server } from "@server/index";
import { ValueTransformer } from "typeorm";
import type { Message } from "../imessage/entity/Message";

export const AttributedBodyTransformer = (message: Message): ValueTransformer => {
    return {
        from: _ => {
            try {
                // This is wrapped in a try because it can throw an error if full
                const batch = Server().objcBatcher.add(message);
                if (!batch) return null;
                return batch.waitForCompletion();
            } catch (ex) {
                return null;
            }
        },
        to: null
    };
};
