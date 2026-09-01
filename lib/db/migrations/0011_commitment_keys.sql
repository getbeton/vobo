ALTER TABLE "artifact_versions" ADD COLUMN "commitment_key" varchar(64);--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "content_purged_at" timestamp;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "key_destroyed_at" timestamp;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "root_key" varchar(64);--> statement-breakpoint
UPDATE "workspaces" SET "root_key" = md5(random()::text || id::text) || md5(clock_timestamp()::text || random()::text) WHERE "root_key" IS NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "root_key" SET NOT NULL;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE OR REPLACE FUNCTION vobo_hkdf_sha256(ikm bytea, salt bytea, info bytea)
RETURNS bytea AS $$
DECLARE
  prk bytea;
  t bytea;
BEGIN
  prk := hmac(ikm, salt, 'sha256');
  t := hmac(info || E'\\x01'::bytea, prk, 'sha256');
  RETURN substring(t from 1 for 32);
END;
$$ LANGUAGE plpgsql IMMUTABLE;--> statement-breakpoint
UPDATE "artifact_versions" av
SET
  "commitment_key" = encode(
    vobo_hkdf_sha256(
      decode(w."root_key", 'hex'),
      convert_to('vobo-commitment-v1', 'UTF8'),
      convert_to(av."id"::text, 'UTF8')
    ),
    'hex'
  ),
  "content_hash" = encode(
    digest(
      vobo_hkdf_sha256(
        decode(w."root_key", 'hex'),
        convert_to('vobo-commitment-v1', 'UTF8'),
        convert_to(av."id"::text, 'UTF8')
      ) || convert_to(av."content_md", 'UTF8'),
      'sha256'
    ),
    'hex'
  )
FROM "review_requests" rr
INNER JOIN "projects" p ON p."id" = rr."project_id"
INNER JOIN "workspaces" w ON w."id" = p."workspace_id"
WHERE av."request_id" = rr."id" AND av."commitment_key" IS NULL;--> statement-breakpoint
DROP FUNCTION vobo_hkdf_sha256(bytea, bytea, bytea);
