import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL auto-cleanup registruojasi tik per globalų afterEach, o vitest.config
// neįjungia `globals: true` — be šio explicit hook'o ankstesnio testo DOM lieka
// ekrane ir getAllByRole randa dublikatus (2026-07-07: LearningPanel testas rado
// 2 "Patvirtinti" mygtukus vietoj 1, nes pirmo testo render'is nebuvo išvalytas).
afterEach(cleanup);
