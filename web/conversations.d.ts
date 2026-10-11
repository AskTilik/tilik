// Types for web/conversations.js (plain JS served to the browser; these let the Node tests type-check against it).

export type Role = "user" | "assistant";
export type ResponseType = "normal" | "research" | "github" | "onchain" | "market" | "combined";

export interface References {
  urls: string[];
  githubRepos: string[];
  addresses: string[];
  txHashes: string[];
  tickers: string[];
}

export interface StoredSource {
  id: number;
  title?: string;
  url?: string;
  domain?: string;
  authority?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: number;
  type?: ResponseType;
  sources: StoredSource[];
  metadata: {
    intents?: string[];
    provider?: string;
    model?: string;
    grounded?: boolean;
    data?: Record<string, { tool: string; data: unknown }[]>;
    references?: References;
    timings?: { totalMs: number };
    /** Failed turn (friendly message shown); excluded from follow-up context. */
    error?: string;
    [key: string]: unknown;
  };
}

export type NewMessage = Omit<Message, "id" | "conversationId" | "createdAt" | "sources" | "metadata"> & Partial<Pick<Message, "sources" | "metadata">>;

export interface Conversation {
  id: string;
  title: string;
  titleEdited: boolean;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export interface RequestContext {
  history: { role: Role; content: string }[];
  context?: { entities: Partial<References> };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export declare const LIMITS: Readonly<{
  maxConversations: number;
  maxMessagesPerConversation: number;
  maxContentChars: number;
  maxSourcesPerMessage: number;
  maxStoreChars: number;
  maxTitleChars: number;
  contextMessages: number;
  contextUserChars: number;
  contextAssistantChars: number;
}>;

export declare function generateTitle(text: string): string;
export declare function relativeTime(ts: number, now?: number): string;
export declare function extractReferences(response: unknown): References;
export declare function compactData(data: unknown): Record<string, { tool: string; data: unknown }[]>;
export declare function assistantMessageFrom(response: unknown): NewMessage;
export declare function summarize(text: string, max?: number): string;
export declare function buildRequestContext(messages: Message[], opts?: { maxMessages?: number }): RequestContext;

export interface ConversationStore {
  readonly persistent: boolean;
  readonly activeId: string | null;
  load(): ConversationStore;
  list(): Conversation[];
  get(id: string): Conversation | null;
  active(): Conversation | null;
  create(): Conversation;
  setActive(id: string): Conversation | null;
  addMessage(conversationId: string, message: NewMessage): Message | null;
  rename(id: string, title: string): boolean;
  remove(id: string): boolean;
  flush(): void;
  contextFor(conversationId: string, opts?: { maxMessages?: number }): RequestContext;
}

export declare function createConversationStore(opts?: {
  storage?: StorageLike | null;
  now?: () => number;
  newId?: () => string;
  onError?: (kind: "unavailable" | "corrupt" | "quota" | "write", err: unknown) => void;
  limits?: Partial<typeof LIMITS> & typeof LIMITS;
}): ConversationStore;

export declare function createSidebarController(opts: { isMobile: () => boolean; render: (open: boolean) => void }): {
  readonly open: boolean;
  toggle(): void;
  close(): void;
  selected(): void;
  resized(): void;
};

export declare function browserStorage(): StorageLike | null;
