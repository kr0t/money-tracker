import {
  createDebt,
  getSummary,
  parseAmountToCents,
  parseJsonBody,
  jsonResponse,
  errorResponse,
} from "./_db.js";

export async function onRequestPost(context) {
  try {
    const data = await parseJsonBody(context.request);
    const name = data.name;
    if (typeof name !== "string") {
      throw new Error("name must be a string");
    }

    let initialCents = 0;
    if (data.amount !== null && data.amount !== undefined && data.amount !== "") {
      initialCents = parseAmountToCents(data.amount);
    }

    const debt = await createDebt(context.env.DB, name, initialCents);
    const summary = await getSummary(context.env.DB);
    return jsonResponse({ debt, summary }, 201);
  } catch (err) {
    return errorResponse(err.message, 400);
  }
}
