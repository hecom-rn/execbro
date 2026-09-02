import { describe, it, expect } from "@jest/globals";

const { convertScreenshotToTapCoords } = await import("../../pro/tap.js");

describe("convertScreenshotToTapCoords harmony (device-pixel space)", () => {
    it("passes delivered pixels through scaled to device pixels, like android", () => {
        const r = convertScreenshotToTapCoords(500, 800, "harmony", 1, 1.2);
        expect(r).toEqual({ x: 600, y: 960 });
    });

    it("does not divide by a DPR (harmony has no points space)", () => {
        const r = convertScreenshotToTapCoords(100, 100, "harmony", 3, 1);
        expect(r).toEqual({ x: 100, y: 100 });
    });
});
