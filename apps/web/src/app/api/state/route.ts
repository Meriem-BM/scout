import { SnapshotSchema } from "@scout/domain";
import { identity } from "@/server/auth";
import { route } from "@/server/http";

export const GET = route(async () => {
  const { client } = await identity();
  const { data, error } = await client.rpc("scout_snapshot");

  if (error) {
    throw new Error("Your workspace could not be loaded.");
  }

  return SnapshotSchema.parse(data);
});
