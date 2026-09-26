-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "blockedByUserId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "allowContactRequests" BOOLEAN NOT NULL DEFAULT true;
