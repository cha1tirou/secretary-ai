export type Email = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  date: string;
  isUnread: boolean;
  listUnsubscribe: string;
  listId: string;
  precedence: string;
};

export type CalendarEvent = {
  id: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  location: string;
};

export type Plan = "trial" | "light" | "pro" | "expired";

export type User = {
  userId: string;
  displayName: string | null;
  plan: Plan;
  trialStartDate: string | null;
  planExpiresAt: string | null;
  gmailToken: string | null;
  gcalToken: string | null;
  writingStyle: string | null;
  briefingHour: number;
  setupStage: string | null;
  useCases: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoogleAccount = {
  id: number;
  userId: string;
  label: string;
  email: string | null;
  gmailToken: string | null;
  gcalToken: string | null;
  createdAt: string;
};

export type BriefingItem = {
  lineUserId: string;
  number: number;
  emailId: string;
  threadId: string;
  type: "reply_needed" | "followup" | "fyi";
  summary: string;
};

export type PendingReply = {
  id: number;
  userId: string;
  threadId: string;
  toAddress: string;
  subject: string;
  draftContent: string;
  status: "pending" | "hold" | "sent" | "cancelled" | "modified";
  createdAt: string;
  sentAt: string | null;
};

