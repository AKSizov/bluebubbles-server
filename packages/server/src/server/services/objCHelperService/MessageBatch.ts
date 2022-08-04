import { generateUuid } from "@server/helpers/utils";
import { MessageBatchStatus, ObjCHelperService } from ".";
import { MessageBatchItem } from "./MessageBatchItem";

export class MessageBatch {
    readonly id: string;

    status: MessageBatchStatus;

    items: MessageBatchItem[];

    completedAt: number = null;

    private timeout: NodeJS.Timer;

    get isFull(): boolean {
        return this.items.length >= this.maxSize;
    }

    constructor(
        private maxSize: number,
        private timeoutMs: number,
        private pendingListeners: Array<(batch: MessageBatch) => void> = []
    ) {
        this.id = generateUuid();
        this.status = MessageBatchStatus.FILLING;
        this.items = [];

        // Setup the timeout for this batch
        this.timeout = setTimeout(() => {
            this.markReadyForProcessing();
        }, this.timeoutMs);
    }

    /**
     * Adds an item to the batch
     *
     * @param item The Message item to add
     */
    addItem(item: MessageBatchItem) {
        this.items.push(item);

        // If we are full after adding the item,
        // let everyone know we are ready for processing
        if (this.isFull) {
            this.markReadyForProcessing();
        }
    }

    /**
     * Marks the batch as ready for processing and calls all pending listeners
     */
    private markReadyForProcessing() {
        // If we are already pending, it means we already notified the listeners
        if (this.status === MessageBatchStatus.PENDING) return;

        // Mark as pending and notify the listeners
        this.status = MessageBatchStatus.PENDING;
        this.pendingListeners.forEach(listener => listener(this));
        if (this.timeout) clearTimeout(this.timeout);
    }

    /**
     * Processes the batch and resolves the promise
     */
    async process() {
        this.status = MessageBatchStatus.PROCESSING;
        const noResponseErr = "No response from Helper Service";
        let finalStatus = MessageBatchStatus.FAILED;

        try {
            const result = await ObjCHelperService.bulkDeserializeAttributedBody(this.items);

            // Iterate over the results, and match them to the batch items
            for (const item of result?.data ?? []) {
                const batchItem = this.items.find(i => i.id === item.id);
                if (batchItem) {
                    batchItem.complete(item?.body);
                }
            }

            finalStatus = MessageBatchStatus.COMPLETED;
        } catch (ex: any) {
            // Do nothing
        }

        this.rejectIncompleteItems(noResponseErr);
        this.completedAt = new Date().getTime();
        this.status = finalStatus;
    }

    rejectIncompleteItems(reason: string) {
        this.items.forEach(item => {
            if (!item.isComplete) {
                item.fail(new Error(reason));
            }
        });
    }

    /**
     * Allows others to wait for this batch to be completed
     *
     * @returns The batch promise
     */
    async waitForCompletion(): Promise<NodeJS.Dict<any>> {
        return await Promise.all(this.items.map(async item => await item.waitForCompletion()));
    }

    /**
     * Adds a new pending listener
     * @param listener The listener to add
     */
    addPendingListener(listener: (batch: MessageBatch) => void) {
        this.pendingListeners.push(listener);
    }

    /**
     * Clears all pending listeners
     */
    removeAllPendingListeners() {
        this.pendingListeners = [];
    }

    /**
     * Rejects the promise and clears all pending listeners
     */
    flush(error = "Batch was flushed") {
        this.rejectIncompleteItems(error);
        this.removeAllPendingListeners();
    }
}
