import { getAuth } from "@clerk/express";
import { GetSalesResponse } from "@workspace/api-zod";
import { db, salesTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/sales", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const sales = await db
    .select()
    .from(salesTable)
    .orderBy(desc(salesTable.saleDate), desc(salesTable.createdAt));

  res.json(GetSalesResponse.parse(sales));
});

export default router;
