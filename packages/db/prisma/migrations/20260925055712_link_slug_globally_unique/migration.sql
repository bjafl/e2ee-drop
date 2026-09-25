/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `Link` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Link_ownerId_slug_key";

-- DropIndex
DROP INDEX "Link_slug_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Link_slug_key" ON "Link"("slug");

-- CreateIndex
CREATE INDEX "Link_ownerId_idx" ON "Link"("ownerId");
