import { DatabaseRepository } from "@server/api/imessage";
import { Message } from "@server/api/imessage/entity/Message";
import { ChangeListener } from "./changeListener";

export class GroupChangeListener extends ChangeListener {
    repo: DatabaseRepository;

    frequencyMs: number;

    constructor(repo: DatabaseRepository, pollFrequency: number) {
        super(pollFrequency);

        this.repo = repo;
        this.frequencyMs = pollFrequency;

        // Start the listener
        this.start();
    }

    async getEntries(after: Date): Promise<void> {
        const offsetDate = new Date(after.getTime() - 5000);
        const entries = await this.repo.getMessages({
            after: offsetDate,
            withChats: true,
            where: [
                {
                    statement: "message.text IS NULL",
                    args: null
                },
                {
                    statement: "message.item_type IN (1, 2, 3)",
                    args: null
                }
            ]
        });

        // Emit the new message
        entries.forEach((entry: any) => {
            // Skip over any that we've finished
            if (this.emittedItems.includes(entry.ROWID)) return;

            // Add to cache
            this.emittedItems.push(entry.ROWID);

            // Send the built message object
            if (entry.itemType === 1 && entry.groupActionType === 0) {
                super.emit("participant-added", this.transformEntry(entry));
            } else if (entry.itemType === 1 && entry.groupActionType === 1) {
                super.emit("participant-removed", this.transformEntry(entry));
            } else if (entry.itemType === 2) {
                super.emit("name-change", this.transformEntry(entry));
            } else if (entry.itemType === 3) {
                super.emit("participant-left", this.transformEntry(entry));
            } else {
                console.warn(`Unhandled message item type: [${entry.itemType}]`);
            }
        });
    }

    // eslint-disable-next-line class-methods-use-this
    transformEntry(entry: Message) {
        return entry;
    }
}
