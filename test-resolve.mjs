import { initializeIndex, resolveApis } from "./dist/stages/specResolver.js";

async function test() {
    try {
        await initializeIndex();
        const result = resolveApis(["chat.messages"]);
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error(e);
    }
}

test();
