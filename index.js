import { createAdminApiClient } from "@shopify/admin-api-client";
import dotenv from "dotenv";

dotenv.config();

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

const UPDATE_DEAL_MUTATION = `
  mutation UpdateMetaobject($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject {
        id
        fields {
          key
          value
        }
      }
      userErrors {
        field
        message
        code
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

const trackedDeals = new Set();

async function fetchAndProcessDeals() {
  try {
    const { data, errors } = await client.request(FETCH_DEALS_QUERY);

    if (errors) {
      console.error("GraphQL errors:", errors);
      return;
    }

    const deals = data.metaobjects.edges;

    for (const deal of deals) {
      const fields = deal.node.fields.reduce((acc, field) => {
        acc[field.key] = field.value;
        return acc;
      }, {});

      if (
        fields.wtf_pricing === "true" &&
        new Date(fields.start_time) <= new Date() &&
        fields.wtf_pricing_started !== "true" &&
        !trackedDeals.has(deal.node.id)
      ) {
        await updateDeal(deal.node.id);
        trackedDeals.add(deal.node.id);
        console.log(`Deal ${deal.node.id} updated and added to tracked deals.`);
      }

      if (trackedDeals.has(deal.node.id)) {
        const isDealComplete = await adjustProductPrices(
          fields.product,
          deal.node.id
        );
        if (isDealComplete) {
          trackedDeals.delete(deal.node.id);
          console.log(
            `Deal ${deal.node.id} completed and removed from tracked deals.`
          );
        }
      }
    }
  } catch (error) {
    console.error("Error fetching or processing deals:", error);
  }
}

async function updateDeal(id) {
  try {
    const variables = {
      id: id,
      metaobject: {
        fields: [
          {
            key: "wtf_pricing_started",
            value: "true",
          },
        ],
      },
    };

    const { data, errors } = await client.request(UPDATE_DEAL_MUTATION, {
      variables: variables,
    });

    if (errors) {
      console.error("GraphQL errors:", errors);
      return;
    }

    if (data.metaobjectUpdate.userErrors.length > 0) {
      console.error("Error updating deal:", data.metaobjectUpdate.userErrors);
    } else {
      console.log(`Successfully updated deal ${id}`);
    }
  } catch (error) {
    console.error("Error updating deal:", error);
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
      priceDifference < 10
        ? compareAtPrice
        : Math.min(currentPrice + 10, compareAtPrice);

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
    await new Promise((resolve) => setTimeout(resolve, 30000)); // 30 second sleep
  }
}

main().catch(console.error);
