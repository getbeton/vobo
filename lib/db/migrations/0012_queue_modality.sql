CREATE TYPE "public"."queue_modality" AS ENUM('text', 'code', 'table', 'image');--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "modality" "queue_modality" DEFAULT 'text' NOT NULL;
