import { asc, desc, eq } from "drizzle-orm";
import express, { Router } from "express";
import { randomUUID } from "node:crypto";
import db from "../db/index.js";
import { homePageContent, products, shops } from "../db/schema.js";
import {
  createDocumentViewUrl,
  deleteStoredDocument,
  getUploadedDocumentMetadata,
  isSupportedDocumentImage,
  storeDocument,
} from "../services/riderDocumentStorage.js";

const homePageContentRouter = Router();
const contentTypes = new Set(["promotion", "suggestion"]);
const imageContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxImageSize = 5 * 1024 * 1024;
const imageKeyPattern =
  /^home-page-content\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isAdmin = (req) => req.user?.userType === "admin";

const removeUploadedImage = async (key) => {
  try {
    const [record] = await db
      .select({ homeContentId: homePageContent.homeContentId })
      .from(homePageContent)
      .where(eq(homePageContent.imageUrl, key))
      .limit(1);
    if (record) return;
    await deleteStoredDocument(key);
  } catch (error) {
    console.error("Could not remove unassociated home content image from S3:", error);
  }
};

const requireAdmin = (req, res, next) => {
  if (isAdmin(req)) return next();
  return res.status(403).json({
    success: false,
    message: "Administrator access required.",
  });
};

const presentRecord = async (record) => ({
  ...record,
  imageUrl: imageKeyPattern.test(record.imageUrl)
    ? await createDocumentViewUrl({
        key: record.imageUrl,
        expiresIn: 3600,
      })
    : record.imageUrl,
});

const queryLinkedContent = () =>
  db
    .select({
      content: homePageContent,
      product: products,
      shop: shops,
    })
    .from(homePageContent)
    .leftJoin(products, eq(homePageContent.productId, products.productId))
    .leftJoin(shops, eq(products.shopId, shops.shopId));

const presentLinkedRecord = async ({ content, product, shop }) => ({
  ...(await presentRecord(content)),
  linkedProduct:
    product && shop
      ? {
          productId: product.productId,
          shopId: shop.shopId,
          productName: product.productName,
          price: product.price,
          discountPrice: product.discountPrice,
          unit: product.unit,
          stockQuantity: product.stockQuantity,
          isAvailable: product.isAvailable,
          shopName: shop.shopName,
          shopCategory: shop.shopCategory,
          shopOpen: shop.isOpen,
          shopVerified: shop.isVerified,
        }
      : null,
});

export function parseContent(body) {
  const contentType =
    typeof body?.contentType === "string" ? body.contentType : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const imageUrl = typeof body?.imageUrl === "string" ? body.imageUrl.trim() : "";
  const productId = Number(body?.productId);
  const price =
    body?.price === "" || body?.price === null || body?.price === undefined
      ? null
      : Number(body.price);
  const location =
    typeof body?.location === "string" ? body.location.trim() : "";
  const rating =
    body?.rating === "" || body?.rating === null || body?.rating === undefined
      ? null
      : Number(body.rating);

  if (!contentTypes.has(contentType)) {
    return { error: "Choose either a promotion or suggestion." };
  }
  if (!title || title.length > 100) {
    return { error: "Title is required and must be 100 characters or fewer." };
  }
  if (!imageKeyPattern.test(imageUrl)) {
    return { error: "Upload a dashboard image before creating the card." };
  }
  if (!Number.isSafeInteger(productId) || productId < 1) {
    return { error: "Select a shop product for this card." };
  }
  if (
    price !== null &&
    (!Number.isFinite(price) || price < 0 || price > 99999999.99)
  ) {
    return { error: "Price must be a non-negative amount up to 99,999,999.99." };
  }
  if (location.length > 150) {
    return { error: "Location is too long." };
  }
  if (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 5)) {
    return { error: "Rating must be a number from 0 to 5." };
  }

  return {
    value: {
      contentType,
      title,
      imageUrl,
      productId,
      price: price === null ? null : price.toFixed(2),
      location: location || null,
      rating: rating === null ? null : rating.toFixed(2),
    },
  };
}

homePageContentRouter.get("/home-page-content", async (_req, res) => {
  try {
    const records = await queryLinkedContent()
      .where(eq(homePageContent.isActive, true))
      .orderBy(asc(homePageContent.displayOrder), desc(homePageContent.createdAt));
    return res.json({
      success: true,
      data: await Promise.all(records.map(presentLinkedRecord)),
    });
  } catch (error) {
    console.error("Could not load customer home content:", error);
    return res.status(500).json({
      success: false,
      message: "Could not load customer home content.",
    });
  }
});

homePageContentRouter.get("/admin/home-page-content", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access required.",
    });
  }

  try {
    const records = await queryLinkedContent()
      .orderBy(asc(homePageContent.displayOrder), desc(homePageContent.createdAt));
    return res.json({
      success: true,
      data: await Promise.all(records.map(presentLinkedRecord)),
    });
  } catch (error) {
    console.error("Could not load admin home content:", error);
    return res.status(500).json({
      success: false,
      message: "Could not load home content.",
    });
  }
});

homePageContentRouter.post(
  "/admin/home-page-content/upload",
  requireAdmin,
  express.raw({
    type: (req) =>
      imageContentTypes.has(
        (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase(),
      ),
    limit: maxImageSize,
  }),
  async (req, res) => {
    const contentType = (req.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const body = req.body;
    if (
      !imageContentTypes.has(contentType) ||
      !Buffer.isBuffer(body) ||
      body.length < 1 ||
      body.length > maxImageSize ||
      !isSupportedDocumentImage(contentType, body)
    ) {
      return res.status(400).json({
        success: false,
        message: "Choose a valid JPG, PNG, or WebP image up to 5 MB.",
      });
    }

    const key = `home-page-content/${randomUUID()}`;
    try {
      await storeDocument({ key, contentType, body });
      return res.json({ success: true, data: { key } });
    } catch (error) {
      console.error("Could not upload home content image:", error);
      return res.status(503).json({
        success: false,
        message: "Image storage is unavailable. Please try again.",
      });
    }
  },
);

homePageContentRouter.post("/admin/home-page-content", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access required.",
    });
  }

  const parsed = await parseContent(req.body);
  if (parsed.error) {
    return res.status(400).json({ success: false, message: parsed.error });
  }

  try {
    const [product] = await db
      .select({
        productId: products.productId,
        isAvailable: products.isAvailable,
        stockQuantity: products.stockQuantity,
        shopOpen: shops.isOpen,
        shopVerified: shops.isVerified,
      })
      .from(products)
      .leftJoin(shops, eq(products.shopId, shops.shopId))
      .where(eq(products.productId, parsed.value.productId))
      .limit(1);
    if (
      !product ||
      product.isAvailable === false ||
      Number(product.stockQuantity ?? 0) < 1 ||
      product.shopOpen !== true ||
      product.shopVerified !== true
    ) {
      await removeUploadedImage(parsed.value.imageUrl);
      return res.status(400).json({
        success: false,
        message: "Select a product that is currently available and in stock.",
      });
    }

    const metadata = await getUploadedDocumentMetadata(parsed.value.imageUrl);
    if (
      !imageContentTypes.has(metadata.contentType) ||
      !Number.isInteger(metadata.fileSize) ||
      metadata.fileSize < 1 ||
      metadata.fileSize > maxImageSize ||
      !metadata.validImage
    ) {
      await removeUploadedImage(parsed.value.imageUrl);
      return res.status(400).json({
        success: false,
        message: "The uploaded image is invalid or exceeds the 5 MB limit.",
      });
    }

    const [record] = await db
      .insert(homePageContent)
      .values(parsed.value)
      .returning();
    return res.status(201).json({
      success: true,
      data: await presentLinkedRecord(
        (
          await queryLinkedContent().where(
            eq(homePageContent.homeContentId, record.homeContentId),
          )
        )[0],
      ),
    });
  } catch (error) {
    console.error("Could not create home content:", error);
    await removeUploadedImage(parsed.value.imageUrl);
    return res.status(500).json({
      success: false,
      message: "Could not create home content.",
    });
  }
});

homePageContentRouter.patch(
  "/admin/home-page-content/:id",
  async (req, res) => {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Administrator access required.",
      });
    }

    const id = Number(req.params.id);
    const body = req.body || {};
    const hasProductId = Object.hasOwn(body, "productId");
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      (body.isActive !== undefined && typeof body.isActive !== "boolean") ||
      (body.isActive === undefined && !hasProductId)
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid record ID and update are required.",
      });
    }

    try {
      const updates = { updatedAt: new Date() };
      if (body.isActive !== undefined) updates.isActive = body.isActive;
      if (hasProductId) {
        const productId =
          body.productId === null ? null : Number(body.productId);
        if (
          productId !== null &&
          (!Number.isSafeInteger(productId) || productId < 1)
        ) {
          return res.status(400).json({
            success: false,
            message: "Select a valid shop product.",
          });
        }
        if (productId !== null) {
          const [product] = await db
            .select({
              productId: products.productId,
              isAvailable: products.isAvailable,
              stockQuantity: products.stockQuantity,
              shopOpen: shops.isOpen,
              shopVerified: shops.isVerified,
            })
            .from(products)
            .leftJoin(shops, eq(products.shopId, shops.shopId))
            .where(eq(products.productId, productId))
            .limit(1);
          if (
            !product ||
            product.isAvailable === false ||
            Number(product.stockQuantity ?? 0) < 1 ||
            product.shopOpen !== true ||
            product.shopVerified !== true
          ) {
            return res.status(400).json({
              success: false,
              message: "Select a product that is currently available and in stock.",
            });
          }
        }
        updates.productId = productId;
      }

      const [record] = await db
        .update(homePageContent)
        .set(updates)
        .where(eq(homePageContent.homeContentId, id))
        .returning();
      if (!record) {
        return res.status(404).json({
          success: false,
          message: "Home content record not found.",
        });
      }
      return res.json({
        success: true,
        data: await presentLinkedRecord(
          (
            await queryLinkedContent().where(
              eq(homePageContent.homeContentId, record.homeContentId),
            )
          )[0],
        ),
      });
    } catch (error) {
      console.error("Could not update home content:", error);
      return res.status(500).json({
        success: false,
        message: "Could not update home content.",
      });
    }
  },
);

homePageContentRouter.delete(
  "/admin/home-page-content/:id",
  async (req, res) => {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Administrator access required.",
      });
    }

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid record ID is required.",
      });
    }

    try {
      const [record] = await db
        .delete(homePageContent)
        .where(eq(homePageContent.homeContentId, id))
        .returning({
          homeContentId: homePageContent.homeContentId,
          imageUrl: homePageContent.imageUrl,
        });
      if (!record) {
        return res.status(404).json({
          success: false,
          message: "Home content record not found.",
        });
      }
      let warning;
      if (imageKeyPattern.test(record.imageUrl)) {
        try {
          await deleteStoredDocument(record.imageUrl);
        } catch (error) {
          console.error("Could not remove deleted home content image from S3:", error);
          warning =
            "The card was deleted, but its image could not be removed from AWS S3.";
        }
      }
      return res.json({
        success: true,
        data: record,
        ...(warning ? { warning } : {}),
      });
    } catch (error) {
      console.error("Could not delete home content:", error);
      return res.status(500).json({
        success: false,
        message: "Could not delete home content.",
      });
    }
  },
);

export default homePageContentRouter;
