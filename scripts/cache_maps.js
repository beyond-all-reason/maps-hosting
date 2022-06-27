// A small scripts to trigger caching of maps, paste maps e.g. from 
// https://github.com/beyond-all-reason/BYAR-Chobby/blob/master/LuaMenu/configs/gameConfig/byar/mapDetails.lua
// to the list below and run it, to trigger a read and a cache.
const maps = ['Aberdeen3v3v3', 'Angel Crossing 1.5'];

async function main() {
    for (const map of maps) {
        const url = new URL('https://bar-springfiles.p2004a.com/find');
        url.searchParams.set('category', 'map');
        url.searchParams.set('springname', map);
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Fetching ${map} failed ${response.status}`);
        } else {
            const res = await response.json();
            console.log(res[0].mirrors[0]);
        }
    }
}

main().catch(err => console.error(err));
