import { Message } from "@server/databases/imessage/entity/Message";
import { generateUuid, waitMs } from "@server/helpers/utils";
import { ObjCHelperService } from ".";

export enum MessageBatchStatus {
    PENDING = "pending",
    PROCESSING = "processing",
    COMPLETED = "completed",
    FAILED = "failed"
}

export type MessageBatch = {
    id: string;
    status: MessageBatchStatus;
    items: Message[];
    promise: Promise<NodeJS.Dict<any>>;
    completedAt: number;
    resolve: (value: NodeJS.Dict<any>) => void;
    reject: (reason?: Error) => void;
};

export interface BatchConfig {
    maxBatchSize?: number;
    maxBatches?: number;
    batchIntervalMs?: number;
}

export class UnarchiveBatcher {
    private batches: Array<MessageBatch> = [];

    private maxBatchSize = 1000;

    private batchIntervalMs = 10;

    private maxBatches = 20;

    /**
     * Checks if the batcher is not processing anything
     *
     * @returns True if the batcher is idle, false otherwise
     */
    get isIdle(): boolean {
        return !this.isProcessing;
    }

    /**
     * Checks if the batches is processing anything
     *
     * @returns True if the batcher is processing, false otherwise
     */
    get isProcessing(): boolean {
        return this.batches.some(batch => batch.status === MessageBatchStatus.PROCESSING);
    }

    /**
     * Checks if there are any batches available to process.
     *
     * @returns True if there are batches available, false otherwise
     */
    get hasPendingBatches(): boolean {
        return !!this.getNextPendingBatch();
    }

    constructor(batchConfig: BatchConfig) {
        this.maxBatchSize = batchConfig?.maxBatchSize ?? this.maxBatchSize;
        this.batchIntervalMs = batchConfig?.batchIntervalMs ?? this.batchIntervalMs;
        this.maxBatches = batchConfig?.maxBatches ?? this.maxBatches;
    }

    /**
     * Creates a brand new batch that defaults to the pending state.
     * This function sets up the resolve and reject proxies so batches
     * can be awaited on.
     *
     * @returns The newly created batch
     */
    private createNewBatch() {
        const newBatch: MessageBatch = {
            id: generateUuid(),
            items: [],
            status: MessageBatchStatus.PENDING,
            promise: null,
            resolve: null,
            reject: null,
            completedAt: null
        };

        // Setup the promise for this batch
        newBatch.promise = new Promise((resolve, reject) => {
            newBatch.resolve = resolve;
            newBatch.reject = reject;
        });

        // Adds the new batch to the list of batches
        this.batches.push(newBatch);
        return newBatch;
    }

    /**
     * Finds a batch by its ID
     *
     * @param id The ID of the batch to find
     * @returns The found batch, or undefined
     */
    public findBatch(id: string) {
        return this.batches.find(batch => batch.id === id);
    }

    /**
     * Finds the next pending batch
     *
     * @returns The next pending batch, or undefined if there is none
     */
    private getNextPendingBatch() {
        return this.batches.find(batch => batch.status === MessageBatchStatus.PENDING);
    }

    /**
     * Find a batch that's not full
     *
     * @returns The next available batch (existing or new)
     */
    private getNextAvailableBatch() {
        // The next batch must be pending and not full
        let batch = this.batches.find(
            batch => batch.items.length < this.maxBatchSize && batch.status === MessageBatchStatus.PENDING
        );
        if (!batch) {
            batch = this.createNewBatch();
        }

        return batch;
    }

    /**
     * Adds a message to be processed by the batcher.
     *
     * @param message The message to queue up processing for
     * @returns The batch that the message was added to
     */
    public add(message: Message): MessageBatch {
        const batch = this.getNextAvailableBatch();
        batch.items.push(message);

        setTimeout(() => {
            this.processNextBatch();
        });
        return batch;
    }

    /**
     * Starts processing the next batch, if there is a batch to process,
     * and if there are no other batches currently processing.
     *
     * @param wasProcessing If this call is a continuation of a previous processing call
     */
    private async processNextBatch(wasProcessing = false): Promise<void> {
        const batch = this.getNextPendingBatch();
        if ((!wasProcessing && this.isProcessing) || !batch) return;

        batch.status = MessageBatchStatus.PROCESSING;

        try {
            const data = await ObjCHelperService.bulkDeserializeAttributedBody(batch.items);
            batch.status = MessageBatchStatus.COMPLETED;
            batch.completedAt = new Date().getTime();
            batch.resolve(data);
        } catch (ex: any) {
            batch.status = MessageBatchStatus.FAILED;
            batch.completedAt = new Date().getTime();
            batch.reject(ex);
        }

        this.pruneBatches();
        await waitMs(this.batchIntervalMs);
        this.processNextBatch(true);
    }

    /**
     * Checks the status of a batch to see if it has completed succesfully or failed.
     *
     * @param batch The batch to check
     * @returns True if the batch has completed or failed, otherwise False
     */
    private isBatchFinished(batch: MessageBatch): boolean {
        return batch.status === MessageBatchStatus.COMPLETED || batch.status === MessageBatchStatus.FAILED;
    }

    /**
     * Prune the batches so there are never more than [maxBatches] batches
     * in the queue. Any pruned batches are rejected if not already completed.
     */
    private pruneBatches() {
        const tries = [30000, 10000, 5000, 0];
        for (const tryMs of tries) {
            this.pruneByAge(tryMs);
            if (this.batches.length <= this.maxBatches) break;
        }

        // If we still are at our max, prune the oldest, but reject them first
        if (this.batches.length > this.maxBatches) {
            const oldest = this.batches.slice(this.maxBatches, this.batches.length);
            oldest.forEach(batch => {
                batch.reject(new Error("Batch was pruned"));
            });

            this.batches = this.batches.slice(0, this.maxBatches);
        }
    }

    /**
     * Prunes any batches that are no longer needed. This is determined
     * by if the batch has finished and it has completed > [msSinceCompletion] seconds ago.
     *
     * @param msSinceCompletion
     */
    private pruneByAge(msSinceCompletion = 5000) {
        const now = new Date().getTime();
        this.batches = this.batches.filter(
            batch => this.isBatchFinished(batch) && now - batch.completedAt > msSinceCompletion
        );
    }

    /**
     * Rejects all the incomplete batches (pending or processing),
     * then clears the batches list.
     */
    public flush() {
        // Reject all the non-completed batches
        const batches = this.batches.filter(batch => !this.isBatchFinished(batch));
        batches.forEach(batch => {
            batch.reject(new Error("Batch was flushed"));
        });

        // Clear the batches
        this.batches = [];
    }
}
