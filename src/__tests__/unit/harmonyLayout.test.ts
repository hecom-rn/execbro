import { describe, it, expect } from "@jest/globals";

const { parseDumpLayout, findLayoutNode } = await import("../../core/harmony.js");

const SAMPLE = JSON.stringify({
    attributes: {
        bounds: "[0,0][1320,2120]", key: "", text: "", type: "root", clickable: "false"
    },
    children: [
        {
            attributes: {
                bounds: "[1120,1968][1320,2120]", key: "tabbarMine", text: " 我的",
                type: "FrameNode", clickable: "true", bundleName: "cn.hecom.cloud.har"
            },
            children: []
        },
        {
            attributes: { bounds: "[0,117][1320,1856]", key: "tabbarMenuPage", text: "", type: "FrameNode", clickable: "false" },
            children: [
                { attributes: { bounds: "[100,300][300,360]", key: "", text: "销售漏斗分析", type: "TextNode", clickable: "true" }, children: [] }
            ]
        }
    ]
});

describe("parseDumpLayout", () => {
    it("parses nodes with device-pixel bounds and testID keys", () => {
        const root = parseDumpLayout(SAMPLE);
        expect(root).not.toBeNull();
        expect(root!.bounds).toEqual([0, 0, 1320, 2120]);
        expect(root!.children[0].key).toBe("tabbarMine");
        expect(root!.children[0].bounds).toEqual([1120, 1968, 200, 152]);
        expect(root!.children[0].clickable).toBe(true);
        expect(root!.children[0].bundleName).toBe("cn.hecom.cloud.har");
    });

    it("returns null on unparseable output", () => {
        expect(parseDumpLayout("not json")).toBeNull();
    });
});

describe("findLayoutNode", () => {
    const root = parseDumpLayout(SAMPLE)!;

    it("finds by testID across depth", () => {
        const n = findLayoutNode(root, { testID: "tabbarMenuPage" });
        expect(n?.bounds).toEqual([0, 117, 1320, 1739]);
    });

    it("finds by visible text when no testID is given", () => {
        expect(findLayoutNode(root, { text: "销售漏斗分析" })?.bounds).toEqual([100, 300, 200, 60]);
    });

    it("returns null when nothing matches", () => {
        expect(findLayoutNode(root, { testID: "nope" })).toBeNull();
    });
});
