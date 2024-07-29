import { createAdminApiClient } from "@shopify/admin-api-client";
import dotenv from "dotenv";

dotenv.config();

const priceIncrement = 9.99;
const dealDuration = 1000;

const client = createAdminApiClient({
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
  apiVersion: "2024-10",
  accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
});

const FETCH_DEALS_QUERY = `
  query {
    metaobjects(type: "deal", first: 250) {
      edges {
        node {
          id
          fields {
            key
            value
          }
        }
      }
    }
  }
`;

const FETCH_PRODUCT_QUERY = `
  query GetProduct($id: ID!) {
    product(id: $id) {
      id
      title
      variants(first: 250) {
        edges {
          node {
            id
            price
            compareAtPrice
          }
        }
      }
    }
  }
`;

const UPDATE_PRODUCT_VARIANT_MUTATION = `
  mutation updateProductVariant($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
      productVariant {
        id
        price
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const trackedDeals = {};

async function fetchAndProcessDeals() {
  try {
    const { data, errors } = await client.request(FETCH_DEALS_QUERY);

    if (errors) {
      console.error("GraphQL errors:", errors);
      return;
    }

    const deals = data.metaobjects.edges;
    console.log(`Fetched ${deals.length} deals.`);

    for (const deal of deals) {
      const fields = deal.node.fields.reduce((acc, field) => {
        acc[field.key] = field.value;
        return acc;
      }, {});

      if (
        fields.wtf_pricing === "true" &&
        new Date(fields.start_time) <= new Date() &&
        !(deal.node.id in trackedDeals)
      ) {
        trackedDeals[deal.node.id] = false;
        console.log(`Deal ${deal.node.id} added to tracked deals.`);
      }

      if (deal.node.id in trackedDeals && !trackedDeals[deal.node.id]) {
        const isDealComplete = await adjustProductPrices(
          fields.product,
          deal.node.id
        );
        if (isDealComplete) {
          trackedDeals[deal.node.id] = true;
          console.log(`Deal ${deal.node.id} completed.`);
        }
      }
    }
  } catch (error) {
    console.error("Error fetching or processing deals:", error);
  }
}

async function adjustProductPrices(productId, dealId) {
  try {
    const { data, errors } = await client.request(FETCH_PRODUCT_QUERY, {
      variables: { id: productId },
    });

    if (errors) {
      console.error("GraphQL errors:", errors);
      return false;
    }

    const variants = data.product.variants.edges;
    let allVariantsComplete = true;

    for (const variant of variants) {
      const isVariantComplete = await incrementVariantPrice(variant.node);
      if (!isVariantComplete) {
        allVariantsComplete = false;
      }
    }

    console.log(`Prices adjusted for product ${data.product.title}`);
    return allVariantsComplete;
  } catch (error) {
    console.error("Error adjusting product prices:", error);
    return false;
  }
}

async function incrementVariantPrice(variant) {
  const currentPrice = parseFloat(variant.price);
  const compareAtPrice = parseFloat(variant.compareAtPrice);

  if (currentPrice < compareAtPrice) {
    const priceDifference = compareAtPrice - currentPrice;
    const newPrice =
      priceDifference < priceIncrement
        ? compareAtPrice
        : Math.min(currentPrice + priceIncrement, compareAtPrice);

    try {
      const { data, errors } = await client.request(
        UPDATE_PRODUCT_VARIANT_MUTATION,
        {
          variables: {
            input: {
              id: variant.id,
              price: newPrice.toFixed(2),
            },
          },
        }
      );

      if (errors) {
        console.error("GraphQL errors:", errors);
        return false;
      }

      if (data.productVariantUpdate.userErrors.length > 0) {
        console.error(
          "Error updating variant price:",
          data.productVariantUpdate.userErrors
        );
        return false;
      } else {
        console.log(
          `Updated variant ${variant.id} price to ${newPrice.toFixed(2)}`
        );
        return newPrice === compareAtPrice;
      }
    } catch (error) {
      console.error("Error updating variant price:", error);
      return false;
    }
  }
  return true;
}

async function main() {
  while (true) {
    await fetchAndProcessDeals();
    await new Promise((resolve) => setTimeout(resolve, dealDuration));
  }
}

main().catch(console.error);
