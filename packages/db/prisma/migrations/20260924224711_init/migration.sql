-- CreateTable
CREATE TABLE "Link" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "slug" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "recipientPublicKey" TEXT NOT NULL,
    "codewordLocale" TEXT NOT NULL DEFAULT 'en',
    "retentionDays" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Drop" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "senderPublicKey" TEXT NOT NULL,
    "senderUserId" TEXT,
    "s3Key" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "contentMD5" TEXT NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Drop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Link_slug_idx" ON "Link"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Link_ownerId_slug_key" ON "Link"("ownerId", "slug");

-- CreateIndex
CREATE INDEX "Drop_linkId_idx" ON "Drop"("linkId");

-- AddForeignKey
ALTER TABLE "Drop" ADD CONSTRAINT "Drop_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "Link"("id") ON DELETE CASCADE ON UPDATE CASCADE;
