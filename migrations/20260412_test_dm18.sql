-- Test migration: triggers DM-18 (NOT NULL without DEFAULT)
-- This file exists to validate the GitHub Action end-to-end.
-- Delete after validation.

CREATE TABLE "test_users" (
  "id" SERIAL PRIMARY KEY,
  "email" TEXT
);

ALTER TABLE "test_users" ADD COLUMN "name" TEXT NOT NULL;
