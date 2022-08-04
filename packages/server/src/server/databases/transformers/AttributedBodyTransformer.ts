import { isEmpty } from "@server/helpers/utils";
import { Server } from "@server/index";
import { MessageBatchItem } from "@server/services/objCHelperService/MessageBatchItem";
import { ValueTransformer } from "typeorm";

export const AttributedBodyTransformer: ValueTransformer = {
    from: attributedBody => {
        if (isEmpty(attributedBody)) return null;

        try {
            // This is wrapped in a try because it can throw an error if full
            const batchItem = new MessageBatchItem(attributedBody);
            const batch = Server().objcBatcher.add(batchItem);
            if (!batch) return null;
            return batchItem.waitForCompletion();
        } catch (ex) {
            return null;
        }
    },
    to: null
};
