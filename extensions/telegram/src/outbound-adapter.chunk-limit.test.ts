// Rich-enabled Telegram accounts must get the 32768-char rich text budget,
// not the 4096 plain-Markdown cap; an explicit textChunkLimit still wins.
import { describe, expect, it, vi } from "vitest";

vi.mock("./send.js", () => ({
  pinMessageTelegram: vi.fn(),
  reactMessageTelegram: vi.fn(),
  sendPollTelegram: vi.fn(),
  sendLocationTelegram: vi.fn(),
  sendMessageTelegram: vi.fn(),
}));

import { telegramOutbound } from "./outbound-adapter.js";

describe("telegramOutbound.resolveEffectiveTextChunkLimit", () => {
  it("raises the limit to the rich text budget for rich accounts", () => {
    const limit = telegramOutbound.resolveEffectiveTextChunkLimit?.({
      cfg: { channels: { telegram: { richMessages: true } } } as never,
      accountId: "default",
      fallbackLimit: 4000,
    });
    expect(limit).toBe(32768);
  });

  it("keeps the 4096 cap for non-rich accounts", () => {
    const limit = telegramOutbound.resolveEffectiveTextChunkLimit?.({
      cfg: { channels: { telegram: {} } } as never,
      accountId: "default",
      fallbackLimit: 4000,
    });
    expect(limit).toBe(4000);
  });

  it("honors an explicit lower textChunkLimit even for rich accounts", () => {
    const limit = telegramOutbound.resolveEffectiveTextChunkLimit?.({
      cfg: {
        channels: { telegram: { richMessages: true, textChunkLimit: 1500 } },
      } as never,
      accountId: "default",
      fallbackLimit: 4000,
    });
    expect(limit).toBe(1500);
  });
});
