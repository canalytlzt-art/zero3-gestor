import { getAuth } from "@clerk/express";
import { GetAccessStatusResponse, GetSalesResponse } from "@workspace/api-zod";
import { db, salesTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { isAuthorizedUser } from "../lib/authorization";

const router: IRouter = Router();

router.get("/access-status", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const data = GetAccessStatusResponse.parse({
    authorized: await isAuthorizedUser(req),
  });
  res.json(data);
});

router.get("/sales", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (!(await isAuthorizedUser(req))) {
    res.status(403).json({ error: "Access is restricted to authorized users" });
    return;
  }

  const sales = await db
    .select()
    .from(salesTable)
    .orderBy(desc(salesTable.saleDate), desc(salesTable.createdAt));

  res.json(GetSalesResponse.parse(sales));
});

export default router;
