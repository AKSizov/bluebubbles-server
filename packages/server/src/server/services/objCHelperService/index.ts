import { FileSystem } from "@server/fileSystem";
import { isNotEmpty } from "@server/helpers/utils";
import { Message } from "@server/databases/imessage/entity/Message";
import { MessageResponse } from "@server/types";
import { Server } from "@server";
import { MessageBatchItem } from "./MessageBatchItem";

export enum MessageBatchStatus {
    FILLING = "filling", // The batch is being filled with messages
    PENDING = "pending", // The batch is waiting to be processed
    PROCESSING = "processing", // The batch is being processed
    COMPLETED = "completed", // The batch has been completed successfully
    FAILED = "failed" // The batch has failed
}

/**
 * A class that handles the communication with the swift helper process.
 */
export class ObjCHelperService {
    static async bulkDeserializeAttributedBody(bodies: MessageBatchItem[]): Promise<NodeJS.Dict<any>> {
        const helperPath = `${FileSystem.resources}/bluebubblesObjcHelper`;

        try {
            const msgs = [];
            for (const i of bodies) {
                if (isNotEmpty(i.body)) {
                    const buff = Buffer.from(i.body);
                    msgs.push({
                        id: i.id,
                        payload: buff.toString("base64")
                    });
                }
            }

            // Send the request to the helper
            // Don't use double-quotes around the payload or else it'll break the command
            const payload = JSON.stringify({ type: "bulk-attributed-body", data: msgs });
            const data = await FileSystem.execShellCommand(`${helperPath} '${payload}'`);
            const json = data.substring(data.indexOf("] ") + 2);
            return JSON.parse(json);
        } catch (ex: any) {
            Server().log(`Failed to deserialize attributed bodies! Error: ${ex?.message ?? String(ex)}`);
            return null;
        }
    }
}
