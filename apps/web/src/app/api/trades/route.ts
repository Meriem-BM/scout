import { randomUUID } from "node:crypto";

import { z } from "zod";

import { Hash, TradeIntentSchema } from "@scout/domain";
import { ethereum } from "@scout/integrations/ethereum";
import {
  StoredQuoteSchema,
  TransactionSchema,
  UniswapAdapter,
} from "@scout/integrations/uniswap";
import { admin, HttpError, identity } from "@/server/auth";
import { required } from "@/server/env";
import { authorizedBudget, body, route } from "@/server/http";

export const maxDuration = 60;

const Json = z.json();
const Input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), intent: TradeIntentSchema }),
  z.object({ action: z.literal("approval"), id: z.string().uuid() }),
  z.object({
    action: z.literal("prepare"),
    id: z.string().uuid(),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .max(1024)
      .nullable(),
  }),
  z.object({
    action: z.literal("register"),
    id: z.string().uuid(),
    hash: Hash,
  }),
]);

export const GET = route(async () => {
  const { userId } = await identity();
  const { data, error } = await admin()
    .from("transaction_intents")
    .select("id,intent,state,transaction_hash,created_at,expires_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    throw new Error("Transaction history could not be loaded.");
  }

  return { trades: data };
});

export const POST = route(async (request) => {
  const input = await body(request, Input);
  const { client, userId } = await authorizedBudget(
    `trade-${input.action}`,
    input.action === "quote" ? 10 : 20,
    60,
  );
  const service = admin();

  if (input.action === "quote") {
    const adapter = new UniswapAdapter(
      required("UNISWAP_API_KEY"),
      ethereum(required("ETHEREUM_RPC_URL")),
    );
    const id = randomUUID();
    const quote = await adapter.quote(input.intent, id);
    const { error } = await client.rpc("scout_quote_save", {
      quote_id: id,
      expected_owner: userId,
      wallet_address: input.intent.wallet,
      intent_data: Json.parse(input.intent),
      quote_data: Json.parse(quote),
      quote_expires: quote.review.expiresAt,
    });

    if (error) {
      throw new Error(
        "The quote could not be saved. No signature was requested.",
      );
    }

    return { review: quote.review };
  }

  const { data: stored, error } = await service
    .from("transaction_intents")
    .select("*")
    .eq("id", input.id)
    .eq("user_id", userId)
    .single();

  if (error || !stored) {
    throw new HttpError(
      404,
      "This transaction intent is not available to your account.",
    );
  }

  if (input.action === "register") {
    if (stored.transaction_hash) {
      if (stored.transaction_hash !== input.hash) {
        throw new HttpError(
          409,
          "A different transaction is already attached to this intent.",
        );
      }

      return { ok: true };
    }

    if (stored.state !== "prepared" || !stored.prepared_transaction) {
      throw new HttpError(
        409,
        "Only a reviewed, prepared transaction can be registered.",
      );
    }

    const { data, error } = await service
      .from("transaction_intents")
      .update({
        transaction_hash: input.hash,
        state: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.id)
      .eq("user_id", userId)
      .eq("state", "prepared")
      .is("transaction_hash", null)
      .select("id");

    if (error || !data?.length) {
      throw new HttpError(
        409,
        "The transaction state changed. Refresh to inspect it; do not resubmit.",
      );
    }

    return { ok: true };
  }

  if (stored.transaction_hash || stored.state !== "quoted") {
    throw new HttpError(
      409,
      "This signing attempt has already been prepared or submitted. Check your wallet history; it cannot be prepared twice. Request a new quote only after resolving the prior attempt.",
    );
  }

  const quote = StoredQuoteSchema.parse(stored.quote);
  const adapter = new UniswapAdapter(
    required("UNISWAP_API_KEY"),
    ethereum(required("ETHEREUM_RPC_URL")),
  );

  if (input.action === "approval") {
    return { transaction: await adapter.approval(quote) };
  }

  const transaction = TransactionSchema.parse(
    await adapter.prepare(quote, input.signature),
  );
  const { data, error: saveError } = await service
    .from("transaction_intents")
    .update({
      prepared_transaction: Json.parse(transaction),
      state: "prepared",
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .eq("user_id", userId)
    .eq("state", "quoted")
    .is("transaction_hash", null)
    .select("id");

  if (saveError || !data?.length) {
    throw new HttpError(
      409,
      "Could not persist the reviewed transaction. No transaction was submitted.",
    );
  }

  return { transaction };
});
