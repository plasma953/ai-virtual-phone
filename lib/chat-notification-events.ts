export const CHAT_MESSAGE_NOTICE_EVENT = "ai-chat-message-notice";
export const CHAT_OPEN_SESSION_EVENT = "ai-chat-open-session";
// 自主冲浪的见闻分享走独立通道：不写入任何聊天会话，只弹桌面横幅。
export const SURF_SHARE_NOTICE_EVENT = "ai-surf-share-notice";
export type SurfShareNoticeDetail = {
  noteId?: string;
  title: string;
  body: string;
};
export function dispatchSurfShareNotice(detail: SurfShareNoticeDetail): void {
  if (typeof window === "undefined") return;
  const body = detail.body.trim();
  if (!detail.title || !body) return;
  window.dispatchEvent(new CustomEvent(SURF_SHARE_NOTICE_EVENT, {
    detail: { ...detail, body },
  }));
}

export type ChatMessageNoticeDetail = {
  sessionId: string;
  body: string;
  senderName?: string;
  avatar?: string | null;
  isGroup?: boolean;
};

export function dispatchChatMessageNotice(detail: ChatMessageNoticeDetail): void {
  if (typeof window === "undefined") return;
  const body = detail.body.trim();
  if (!detail.sessionId || !body) return;
  window.dispatchEvent(new CustomEvent(CHAT_MESSAGE_NOTICE_EVENT, {
    detail: { ...detail, body },
  }));
}

// 打开联系人 tab 的「添加朋友」页并预载指定角色资料（名片点击添加）
export const CHAT_OPEN_ADD_CONTACT_EVENT = "ai-chat-open-add-contact";

export function dispatchOpenAddContact(characterId: string): void {
  if (typeof window === "undefined" || !characterId) return;
  window.dispatchEvent(new CustomEvent(CHAT_OPEN_ADD_CONTACT_EVENT, { detail: { characterId } }));
}
