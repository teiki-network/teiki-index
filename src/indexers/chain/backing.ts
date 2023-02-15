import * as O from "@cardano-ogmios/schema";
import { Address } from "lucid-cardano";

import { deconstructAddress } from "@teiki/protocol/helpers/schema";
import * as S from "@teiki/protocol/schema";
import { BackingDatum } from "@teiki/protocol/schema/teiki/backing";
import { Hex, UnixTime } from "@teiki/protocol/types";
import { assert } from "@teiki/protocol/utils";

import { $handlers } from "../../framework/chain";
import { prettyOutRef, slotFrom } from "../../framework/chain/conversions";
import { Lovelace } from "../../types/chain";
import { NonEmpty } from "../../types/typelevel";

import { TeikiChainIndexContext } from "./context";

export type ChainBacking = {
  projectId: Hex;
  backerAddress: Address;
  backingAmount: Lovelace;
  milestoneBacked: number;
  backingMessage: string | null;
  unbackingMessage: string | null;
  backedAt: UnixTime;
  unbackedAt: UnixTime | null;
};

export type Event = { type: "backing"; indicies: NonEmpty<number[]> | null };
const $ = $handlers<TeikiChainIndexContext, Event>();

export const setup = $.setup(async ({ sql }) => {
  // TODO: Rename staked_at => backed_at in contracts
  // TODO: Rename unstaked_at => unbacked_at in contracts
  // TODO: Rename unstake => unback in contracts
  await sql`
    CREATE TABLE IF NOT EXISTS chain.backing (
      id bigint PRIMARY KEY REFERENCES chain.output (id) ON DELETE CASCADE,
      project_id varchar(64) NOT NULL,
      backer_address text NOT NULL,
      backing_amount bigint NOT NULL,
      milestone_backed smallint NOT NULL,
      backing_message text,
      unbacking_message text,
      backed_at timestamptz NOT NULL,
      unbacked_at timestamptz
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS backing_pid_index
      ON chain.backing(project_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS backing_backer_address_index
      ON chain.backing(backer_address)
  `;
});

export const filter = $.filter(
  ({
    tx,
    context: {
      config: {
        assetsProofOfBacking: { seed, wilted },
      },
    },
  }) => {
    const backingIndicies: number[] = [];
    for (const [index, output] of tx.body.outputs.entries()) {
      const assets = output.value.assets;
      if (assets && seed.some((a) => assets[a] === 1n))
        backingIndicies.push(index);
    }
    if (backingIndicies.length) {
      return [{ type: "backing", indicies: backingIndicies }];
    } else {
      const minted = tx.body.mint.assets;
      if (minted) {
        const isMinted = (a: string) => minted[a];
        if (seed.some(isMinted) || wilted.some(isMinted))
          return [{ type: "backing", indicies: null }];
      }
    }
    return null;
  }
);

export const event = $.event(
  async ({
    driver,
    connections: { sql, lucid, slotTimeInterpreter },
    block: { slot },
    tx,
    event: { indicies },
  }) => {
    const txTimeStart = slotTimeInterpreter.slotToAbsoluteTime(
      tx.body.validityInterval.invalidBefore ?? slot
    );
    const unbackingMessage = extractCip20Message(tx)?.join("\n") || null;
    // TODO: Bounded unbacked_at?
    const unbackResult = await sql`
      UPDATE chain.backing b
      SET unbacking_message = ${unbackingMessage},
          unbacked_at = ${txTimeStart}
      FROM chain.output o
      WHERE
        o.id = b.id
        AND (o.tx_id, o.tx_ix) IN ${sql(
          tx.body.inputs.map((input) => sql([input.txId, input.index]))
        )}
    `;
    if (indicies != null) {
      // Since backers can unback and back in the same transaction
      // If there's a CIP-20 message, we will count it towards unbackings if possible; otherwise, backings
      const backingMessage = unbackResult.count ? null : unbackingMessage;
      const backings = await driver.store(indicies, (output) => {
        if (output.datum == null) {
          console.warn(
            "datum should be available for backing",
            prettyOutRef(output)
          );
          return undefined;
        }
        const backingDatum = S.fromData(S.fromCbor(output.datum), BackingDatum);
        return [
          "backing",
          {
            projectId: backingDatum.projectId.id,
            backerAddress: deconstructAddress(
              lucid,
              backingDatum.backerAddress
            ),
            backingAmount: output.value.lovelace,
            milestoneBacked: Number(backingDatum.milestoneBacked),
            backingMessage,
            // TODO: Remove the `Math.min` part after we do the final migration on testnet
            // The new contract should already use TxTimeStart instead of TxTimeEnd for backed_at
            backedAt: Math.min(
              txTimeStart,
              Number(backingDatum.backedAt.timestamp)
            ),
          },
        ];
      });
      if (!backings.length) console.warn("there is no valid backing");
      else await sql`INSERT INTO chain.backing ${sql(backings)}`;
    }
    driver.refresh("views.project_summary");
  }
);

export const rollback = $.rollback(
  async ({ connections: { sql, views }, point }) => {
    await sql`
      UPDATE chain.backing b
      SET unbacking_message = NULL,
          unbacked_at = NULL
      FROM chain.output o
      WHERE
        o.id = b.id
        AND o.spent_slot > ${slotFrom(point)}
    `;
    views.refresh("views.project_summary");
  }
);

function extractCip20Message(tx: O.TxBabbage): string[] | null {
  const metadatum = tx.metadata?.body?.blob?.["674"];
  if (metadatum != null && "map" in metadatum)
    for (const { k, v } of metadatum.map)
      if ("string" in k && k.string === "msg") {
        assert("list" in v, "374.msg must be a list");
        const result = [];
        for (const e of v.list) {
          assert("string" in e, "374.msg elements must be strings");
          result.push(e.string);
        }
        return result;
      }
  return null;
}
