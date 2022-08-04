import { Server } from "@server";
import { waitMs } from "@server/helpers/utils";
import { MessageBatchStatus } from ".";
import { MessageBatch } from "./MessageBatch";
import { MessageBatchItem } from "./MessageBatchItem";

export interface BatchConfig {
    maxBatchSize?: number;
    maxBatchCache?: number;
    batchIntervalMs?: number;
}

export class UnarchiverBatcher {
    private batches: Array<MessageBatch> = [];

    private maxBatchSize = 1000;

    private batchIntervalMs = 10;

    private maxBatchCache = 5;

    /**
     * Checks if the batcher is not processing anything
     *
     * @returns True if the batcher is idle, false otherwise
     */
    get isIdle(): boolean {
        return !this.isProcessing;
    }

    /**
     * Checks if the batcher is processing anything
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

    /**
     * Checks if the batcher is full
     */
    get isFull(): boolean {
        return this.batches.length >= this.maxBatchCache;
    }

    constructor(batchConfig: BatchConfig) {
        this.maxBatchSize = batchConfig?.maxBatchSize ?? this.maxBatchSize;
        this.batchIntervalMs = batchConfig?.batchIntervalMs ?? this.batchIntervalMs;
        this.maxBatchCache = batchConfig?.maxBatchCache ?? this.maxBatchCache;
    }

    /**
     * Creates a brand new batch that defaults to the pending state.
     * This function sets up the resolve and reject proxies so batches
     * can be awaited on.
     *
     * @returns The newly created batch
     */
    private createNewBatch() {
        const batch = new MessageBatch(this.maxBatchSize, this.batchIntervalMs, [
            (_: MessageBatch) => {
                this.processNextBatch();
            }
        ]);

        this.batches.push(batch);
        return batch;
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
        let batch = this.batches.find(batch => batch.status === MessageBatchStatus.FILLING);
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
     * @throws If the batcher is full
     */
    public add(message: MessageBatchItem): MessageBatch {
        if (!message) return null;
        const batch = this.getNextAvailableBatch();
        batch.addItem(message);
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

        // If we were processing but don't have a next batch, we're done processing for now
        if (wasProcessing && !batch) {
            // If full, try to prune branches
            if (this.isFull) this.pruneBatches();
            return;
        }

        // If we're already processing, don't do anything
        if ((this.isProcessing && !wasProcessing) || !batch) return;

        // Process the next batch
        Server().log(`[UnarchiverBatcher] Processing batch of ${batch.items.length} items...`);
        await batch.process();

        // Wait the interval time before processing the next batch
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
            if (!this.isFull) break;
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
            batch.flush();
        });

        // Clear the batches
        this.batches = [];
    }
}
