import { z } from "zod";

import { poolByAddress, usd } from "@scout/domain";

import { assertServer, fetchJson, IntegrationError } from "./http";

import type { Incident } from "@scout/domain";

const TelegramResponse = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

export class TelegramAdapter {
  constructor(
    private readonly token: string,
    private readonly siteUrl: string,
  ) {
    assertServer();
  }
  private async request(
    method: "sendMessage" | "answerCallbackQuery",
    body: unknown,
  ) {
    const response = TelegramResponse.parse(
      await fetchJson(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        10_000,
      ),
    );

    if (!response.ok) {
      throw new IntegrationError(
        `TELEGRAM_${response.error_code ?? "ERROR"}`,
        "Telegram could not deliver this message.",
        response.parameters?.retry_after ?? null,
      );
    }

    return response.result;
  }
  async send(chatId: string, incident: Incident) {
    const pool = poolByAddress(incident.detection.pool);
    const result = await this.request("sendMessage", {
      chat_id: chatId,
      text: `Scout · ${incident.title}\nEthereum · Uniswap v3 · ${pool.name} ${pool.feeLabel}\n${usd(incident.detection.totalUsdMicros)} gross selling · ${incident.detection.transactionCount} transactions\n${incident.detection.matches
        .filter((match) => match.matched)
        .map((match) => match.rule)
        .join(
          "\n",
        )}\nFinalized evidence. Initiator does not establish ownership.`,
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "View incident",
              url: `${this.siteUrl}/watches/${incident.watchId}/incidents/${incident.id}`,
            },
          ],
          [
            {
              text: "Mute watch for 1 hour",
              callback_data: `mute:${incident.watchId}`,
            },
          ],
        ],
      },
    });

    return z.object({ message_id: z.number().int() }).parse(result).message_id;
  }
  async sendFinding(chatId: string, lines: string[], watchId: string) {
    const result = await this.request("sendMessage", {
      chat_id: chatId,
      text: `Scout\n${lines.join("\n")}`,
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [{ text: "Open Watch", url: `${this.siteUrl}/watches/${watchId}` }],
        ],
      },
    });

    return z.object({ message_id: z.number().int() }).parse(result).message_id;
  }
  async test(chatId: string) {
    const result = await this.request("sendMessage", {
      chat_id: chatId,
      text: "Scout · Test alert\nTelegram is connected. Live incidents will appear here and remain in their watch history. This is a delivery test, not a detected event.",
    });

    return z.object({ message_id: z.number().int() }).parse(result).message_id;
  }
  async acknowledge(callbackId: string, text: string) {
    return this.request("answerCallbackQuery", {
      callback_query_id: callbackId,
      text,
    });
  }
}

export const TelegramUpdate = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      text: z.string().max(500).optional(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
      from: z
        .object({
          id: z.number().int(),
          first_name: z.string().max(100).optional(),
          is_bot: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().max(64).optional(),
      from: z.object({ id: z.number().int() }),
      message: z
        .object({ chat: z.object({ id: z.number().int(), type: z.string() }) })
        .optional(),
    })
    .optional(),
});
