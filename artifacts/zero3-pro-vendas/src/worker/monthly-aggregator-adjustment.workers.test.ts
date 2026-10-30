import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildOccupancyChartAnalytics } from "../lib/occupancy-chart-data";
import { handleOccupancyRequest } from "./occupancy";
import type { AuthContext, WorkerEnv } from "./types";

const workerEnv = env as unknown as WorkerEnv;
const actor: AuthContext = {
  userId: "monthly-aggregator-test-admin",
  email: "worker-test@example.invalid",
  authorized: true,
};

async function callOccupancy(path: string, method = "GET", body?: unknown) {
  const request = new Request(`https://zero3.test/api${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const response = await handleOccupancyRequest(
    request,
    workerEnv,
    actor,
    path.split("?")[0]!,
  );
  expect(response, `${method} ${path} should resolve to a Worker route`).toBeTruthy();
  return {
    response: response!,
    payload: response!.status === 204 ? null : await response!.json(),
  };
}

describe("monthly aggregator adjustment Worker API", () => {
  it("previews, saves, updates, and undoes estimates while preserving recorded values", async () => {
    const suffix = crypto.randomUUID();
    const month = "2026-11";
    const modalityName = `Modalidade ajuste mensal ${suffix}`;
    const modality = await callOccupancy("/occupancy/modalities", "POST", { name: modalityName });
    expect(modality.response.status).toBe(201);

    const rows = [
      { day: "2026-11-03", label: "Registrado 90", presences: 90, capacity: 100, aggregatorPresences: 90 },
      { day: "2026-11-05", label: "Registrado zero", presences: 0, capacity: 10, aggregatorPresences: 0 },
      { day: "2026-11-10", label: "Sem dado 300", presences: 300, capacity: 350 },
      { day: "2026-11-12", label: "Sem dado 610", presences: 610, capacity: 700 },
    ];
    const created = [];
    for (const row of rows) {
      const result = await callOccupancy("/occupancy", "POST", {
        kind: "daily",
        period: row.day,
        modalityId: modality.payload.id,
        modalityName,
        startTime: "06:00",
        presences: row.presences,
        capacity: row.capacity,
        ...(row.aggregatorPresences === undefined ? {} : { aggregatorPresences: row.aggregatorPresences }),
        className: `${row.label} ${suffix}`,
      });
      expect(result.response.status).toBe(201);
      created.push(result.payload);
    }
    const monthlyLegacy = await callOccupancy("/occupancy", "POST", {
      kind: "monthly",
      period: month,
      modalityId: modality.payload.id,
      modalityName,
      percentage: 74,
      className: `Resumo mensal ${suffix}`,
    });
    expect(monthlyLegacy.response.status).toBe(201);

    const conflictPreview = await callOccupancy("/occupancy/monthly-aggregator-adjustments/preview", "POST", {
      month,
      modalityId: modality.payload.id,
      targetPresences: 89,
    });
    expect(conflictPreview.response.status).toBe(200);
    expect(conflictPreview.payload).toMatchObject({
      canSave: false,
      totalPresences: 1000,
      recordedAggregatorPresences: 90,
      message: expect.stringContaining("menor"),
    });

    const preview = await callOccupancy("/occupancy/monthly-aggregator-adjustments/preview", "POST", {
      month,
      modalityId: modality.payload.id,
      targetPresences: 230,
    });
    expect(preview.response.status).toBe(200);
    expect(preview.payload).toMatchObject({
      canSave: true,
      totalPresences: 1000,
      recordedAggregatorPresences: 90,
      previousEstimatedPresences: 0,
      remainingToDistribute: 140,
      otherPresences: 770,
      measuredClassCount: 4,
      candidateClassCount: 2,
    });
    expect(preview.payload.allocations.map((item: { assignedAggregatorPresences: number }) => item.assignedAggregatorPresences))
      .toEqual([46, 94]);

    const saveBody = {
      month,
      modalityId: modality.payload.id,
      targetPresences: 230,
      expectedVersion: preview.payload.expectedVersion,
      adjustmentId: preview.payload.adjustmentId,
      snapshotToken: preview.payload.snapshotToken,
    };
    const competingSaves = await Promise.all([
      callOccupancy(`/occupancy/monthly-aggregator-adjustments/${month}`, "PUT", saveBody),
      callOccupancy(`/occupancy/monthly-aggregator-adjustments/${month}`, "PUT", saveBody),
    ]);
    expect(competingSaves.map((result) => result.response.status).sort()).toEqual([200, 409]);
    const save = competingSaves.find((result) => result.response.status === 200)!;
    expect(save.payload).toMatchObject({
      targetPresences: 230,
      version: 1,
      active: true,
      modalityId: modality.payload.id,
    });

    const loadedAdjustment = await callOccupancy(`/occupancy/monthly-aggregator-adjustments?month=${month}`);
    expect(loadedAdjustment.response.status).toBe(200);
    expect(loadedAdjustment.payload).toHaveLength(1);
    expect(loadedAdjustment.payload[0]).toMatchObject({ targetPresences: 230, active: true });

    const records = await callOccupancy(`/occupancy?months=${month}&kind=daily&modalityId=${modality.payload.id}`);
    expect(records.response.status).toBe(200);
    expect(records.payload).toHaveLength(4);
    expect(records.payload.find((item: { id: string }) => item.id === created[0].id))
      .toMatchObject({ aggregatorPresences: 90, aggregatorSource: "recorded" });
    expect(records.payload.find((item: { id: string }) => item.id === created[1].id))
      .toMatchObject({ aggregatorPresences: 0, aggregatorSource: "recorded" });
    expect(records.payload.find((item: { id: string }) => item.id === created[2].id))
      .toMatchObject({ aggregatorPresences: 46, aggregatorSource: "monthly_estimated" });
    expect(records.payload.find((item: { id: string }) => item.id === created[3].id))
      .toMatchObject({ aggregatorPresences: 94, aggregatorSource: "monthly_estimated" });
    const analytics = buildOccupancyChartAnalytics(records.payload, {
      viewMode: "monthly",
      selectedMonths: [month],
      modalityId: modality.payload.id,
    });
    expect(analytics.totals).toMatchObject({
      presences: 1000,
      aggregatorPresences: 230,
      otherPresences: 770,
      aggregatorInformedClassCount: 4,
    });

    const updatedPreview = await callOccupancy("/occupancy/monthly-aggregator-adjustments/preview", "POST", {
      month,
      modalityId: modality.payload.id,
      targetPresences: 240,
    });
    expect(updatedPreview.payload).toMatchObject({
      canSave: true,
      recordedAggregatorPresences: 90,
      previousEstimatedPresences: 140,
      remainingToDistribute: 150,
    });
    const update = await callOccupancy(`/occupancy/monthly-aggregator-adjustments/${month}`, "PUT", {
      month,
      modalityId: modality.payload.id,
      targetPresences: 240,
      expectedVersion: updatedPreview.payload.expectedVersion,
      adjustmentId: updatedPreview.payload.adjustmentId,
      snapshotToken: updatedPreview.payload.snapshotToken,
    });
    expect(update.response.status).toBe(200);
    expect(update.payload).toMatchObject({ targetPresences: 240, version: 2, active: true });

    const undo = await callOccupancy(`/occupancy/monthly-aggregator-adjustments/${save.payload.id}`, "DELETE", {
      expectedVersion: 2,
    });
    expect(undo.response.status).toBe(204);
    const reloaded = await callOccupancy(`/occupancy?months=${month}&kind=daily&modalityId=${modality.payload.id}`);
    expect(reloaded.payload.find((item: { id: string }) => item.id === created[0].id))
      .toMatchObject({ aggregatorPresences: 90, aggregatorSource: "recorded" });
    expect(reloaded.payload.find((item: { id: string }) => item.id === created[1].id))
      .toMatchObject({ aggregatorPresences: 0, aggregatorSource: "recorded" });
    expect(reloaded.payload.find((item: { id: string }) => item.id === created[2].id))
      .toMatchObject({ aggregatorPresences: null, aggregatorSource: null });
    expect(reloaded.payload.find((item: { id: string }) => item.id === created[3].id))
      .toMatchObject({ aggregatorPresences: null, aggregatorSource: null });
    const inactiveAdjustment = await callOccupancy(`/occupancy/monthly-aggregator-adjustments?month=${month}`);
    expect(inactiveAdjustment.payload[0]).toMatchObject({ active: false, targetPresences: 240 });
  });
});
