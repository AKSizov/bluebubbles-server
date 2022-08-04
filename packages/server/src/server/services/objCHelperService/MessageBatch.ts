import { Message } from "@server/databases/imessage/entity/Message";
import { generateUuid } from "@server/helpers/utils";
import { MessageBatchStatus, ObjCHelperService } from ".";

export class MessageBatch {
    readonly id: string;

    status: MessageBatchStatus;

    items: Message[];

    completedAt: number = null;

    private promise: Promise<NodeJS.Dict<any>> = null;

    private resolve: (value: NodeJS.Dict<any>) => void;

    private reject: (reason?: Error) => void;

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

        // Setup the promise for this batch
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });

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
    addItem(item: Message) {
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

        try {
            const data = await ObjCHelperService.bulkDeserializeAttributedBody(this.items);
            this.status = MessageBatchStatus.COMPLETED;
            this.completedAt = new Date().getTime();
            this.resolve(data);
        } catch (ex: any) {
            this.status = MessageBatchStatus.FAILED;
            this.completedAt = new Date().getTime();
            this.reject(ex);
        }
    }

    /**
     * Allows others to wait for this batch to be completed
     *
     * @returns The batch promise
     */
    async waitForCompletion(): Promise<NodeJS.Dict<any>> {
        return await this.promise;
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
        this.reject(new Error(error));
        this.removeAllPendingListeners();
    }
}
