/**
 * Internal message types used across the application.
 * Decoupled from any specific provider's raw payload format.
 */

export interface IncomingMessage {
  /** Provider-specific event ID for idempotency */
  eventId?: string;
  /** Unique message ID */
  messageId: string;
  /** Chat/conversation ID (group ID or private chat ID) */
  chatId: string;
  /** Sender's WhatsApp ID */
  senderId: string;
  /** Sender's display name */
  senderName?: string;
  /** Text content of the message */
  text: string;
  /** Whether this message was sent in a group */
  isGroup: boolean;
  /** Whether this message was sent by the bot's own account */
  isFromMe: boolean;
  /** List of mentioned WhatsApp IDs in this message */
  mentionedIds: string[];
  /** Unix timestamp in milliseconds */
  timestamp?: number;
  /** Original message type (text, image, audio, etc.) */
  messageType?: string;
  /** Quoted message stanzaId (the message ID being replied to) */
  quotedStanzaId?: string;
  /** Quoted message sender/participant JID */
  quotedParticipant?: string;
  /** Text of the quoted message */
  quotedText?: string;
  /** Whether the quoted message was sent by the bot */
  isQuotingBot?: boolean;
}

export interface OutgoingMessage {
  /** Target chat ID to send the reply to */
  chatId: string;
  /** Text content to send */
  text: string;
}

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}
