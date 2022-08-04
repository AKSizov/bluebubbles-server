import { generateUuid } from "@server/helpers/utils";

export class MessageBatchItem {
    id: string;

    private promise: Promise<NodeJS.Dict<any>> = null;

    private resolve: (value: NodeJS.Dict<any>) => void;

    private reject: (reason?: Error) => void;

    private finished = false;

    get isComplete(): boolean {
        return this.finished;
    }

    get body(): Blob {
        return this.attributedBody;
    }

    constructor(private attributedBody: Blob) {
        this.id = generateUuid();

        // Setup the promise for this batch
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }

    complete(value: NodeJS.Dict<any>) {
        if (this.finished) return;
        this.finished = true;
        this.resolve(value);
    }

    fail(reason?: Error) {
        if (this.finished) return;
        this.finished = true;
        this.reject(reason);
    }

    async waitForCompletion(): Promise<NodeJS.Dict<any>> {
        return await this.promise;
    }
}
