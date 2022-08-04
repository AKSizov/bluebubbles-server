import { Server } from "@server";
import { getAttachmentResponse } from "@server/databases/imessage/entity/Attachment";
import { getChatResponse } from "@server/databases/imessage/entity/Chat";
import { getHandleResponse } from "@server/databases/imessage/entity/Handle";
import { isEmpty, isNotEmpty } from "@server/helpers/utils";
import { ObjCHelperService } from "@server/services";
import { HandleResponse, MessageResponse } from "@server/types";
import type { MessageSerializerParams, MessageSerializerSingleParams } from "./types";

export class MessageSerializer {
    static async serialize({
        message,
        attachmentConfig = {
            convert: true,
            getData: false,
            loadMetadata: true
        },
        parseAttributedBody = true,
        loadChatParticipants = true
    }: MessageSerializerSingleParams): Promise<MessageResponse> {
        return (
            await MessageSerializer.serializeList({
                messages: [message],
                attachmentConfig,
                parseAttributedBody,
                loadChatParticipants
            })
        )[0];
    }

    static async serializeList({
        messages,
        attachmentConfig = {
            convert: true,
            getData: false,
            loadMetadata: true
        },
        parseAttributedBody = true,
        loadChatParticipants = true
    }: MessageSerializerParams): Promise<MessageResponse[]> {
        // Bulk serialize the attributed bodies
        // const attributedMessages: NodeJS.Dict<any> = await ObjCHelperService.bulkDeserializeAttributedBody(messages);

        // Convert the messages to their serialized versions
        const messageResponses: MessageResponse[] = [];
        for (const message of messages) {
            messageResponses.push(
                await MessageSerializer.convert({
                    message: message,
                    attachmentConfig,
                    parseAttributedBody,
                    loadChatParticipants
                })
            );
        }

        // // Link the decoded attributed bodies to the original messages
        // for (const item of attributedMessages.data) {
        //     const matchIndex = messageResponses.findIndex(m => m.guid === item.id);
        //     messageResponses[matchIndex].attributedBody = item.body;
        // }

        // Handle fetching the chat participants with the messages (if requested)
        const chatCache: { [key: string]: HandleResponse[] } = {};
        if (loadChatParticipants) {
            for (let i = 0; i < messages.length; i++) {
                // If there aren't any chats for this message, skip it
                if (isEmpty(messages[i]?.chats ?? [])) continue;

                // Iterate over the chats for this message and load the participants.
                // We only need to load the participants for group chats since DMs don't have them.
                // Once we load the chat participants for a chat, we will cache it to be used later.
                for (let k = 0; k < (messages[i]?.chats ?? []).length; i++) {
                    // If it's not a group, skip it (style == 43; DM = 45)
                    // Also skip it if there are already participants
                    if (messages[i]?.chats[k].style !== 43 || isNotEmpty(messages[i]?.chats[k].participants)) continue;

                    // Get the participants for this chat, or load it from our cache
                    if (!Object.keys(chatCache).includes(messages[i]?.chats[k].guid)) {
                        const chats = await Server().iMessageRepo.getChats({
                            chatGuid: messages[i]?.chats[k].guid,
                            withParticipants: true
                        });
                        if (isNotEmpty(chats)) {
                            chatCache[messages[i]?.chats[k].guid] = await Promise.all(
                                (chats[0].participants ?? []).map(async p => await getHandleResponse(p))
                            );
                            messageResponses[i].chats[k].participants = chatCache[messages[i]?.chats[k].guid];
                        }
                    } else {
                        messageResponses[i].chats[k].participants = chatCache[messages[i].chats[k].guid];
                    }
                }
            }
        }

        return messageResponses;
    }

    private static async convert({
        message,
        attachmentConfig = {
            convert: true,
            getData: false,
            loadMetadata: true
        }
    }: MessageSerializerSingleParams): Promise<MessageResponse> {
        // Load attachments
        const attachments = [];
        for (const attachment of message?.attachments ?? []) {
            const resData = await getAttachmentResponse(attachment, {
                convert: attachmentConfig.convert,
                getData: attachmentConfig.getData,
                loadMetadata: attachmentConfig.loadMetadata
            });
            attachments.push(resData);
        }

        const chats = [];
        for (const chat of message?.chats ?? []) {
            const chatRes = await getChatResponse(chat);
            chats.push(chatRes);
        }

        return {
            originalROWID: message.ROWID,
            guid: message.guid,
            text: message.text,
            attributedBody: await message.attributedBody,
            handle: message.handle ? await getHandleResponse(message.handle) : null,
            handleId: message.handleId,
            otherHandle: message.otherHandle,
            chats,
            attachments,
            subject: message.subject,
            country: message.country,
            error: message.error,
            dateCreated: message.dateCreated ? message.dateCreated.getTime() : null,
            dateRead: message.dateRead ? message.dateRead.getTime() : null,
            dateDelivered: message.dateDelivered ? message.dateDelivered.getTime() : null,
            isFromMe: message.isFromMe,
            isDelayed: message.isDelayed,
            isAutoReply: message.isAutoReply,
            isSystemMessage: message.isSystemMessage,
            isServiceMessage: message.isServiceMessage,
            isForward: message.isForward,
            isArchived: message.isArchived,
            cacheRoomnames: message.cacheRoomnames,
            isAudioMessage: message.isAudioMessage,
            hasDdResults: message.hasDdResults,
            datePlayed: message.datePlayed ? message.datePlayed.getTime() : null,
            itemType: message.itemType,
            groupTitle: message.groupTitle,
            groupActionType: message.groupActionType,
            isExpired: message.isExpirable,
            balloonBundleId: message.balloonBundleId,
            associatedMessageGuid: message.associatedMessageGuid,
            associatedMessageType: message.associatedMessageType,
            expressiveSendStyleId: message.expressiveSendStyleId,
            timeExpressiveSendStyleId: message.timeExpressiveSendStyleId
                ? message.timeExpressiveSendStyleId.getTime()
                : null,
            replyToGuid: message.replyToGuid,
            isCorrupt: message.isCorrupt,
            isSpam: message.isSpam,
            threadOriginatorGuid: message.threadOriginatorGuid,
            threadOriginatorPart: message.threadOriginatorPart
        };
    }
}
