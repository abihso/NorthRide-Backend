import assert from "node:assert/strict";
import test from "node:test";
import { parseContent } from "../src/routes/homePageContentRoute.js";

const validContent = {
  contentType: "promotion",
  title: "Fresh fruit",
  imageUrl: "home-page-content/550e8400-e29b-41d4-a716-446655440000",
  productId: "42",
};

test("home content requires a valid linked shop product", () => {
  assert.deepEqual(parseContent(validContent).value, {
    contentType: "promotion",
    title: "Fresh fruit",
    imageUrl: validContent.imageUrl,
    productId: 42,
    price: null,
    location: null,
    rating: null,
  });
  assert.match(parseContent({ ...validContent, productId: "invalid" }).error, /shop product/);
  const { productId: _productId, ...unlinkedContent } = validContent;
  assert.match(parseContent(unlinkedContent).error, /shop product/);
});
