"""
tests/browser-check.py: drives the real page in Chromium (Playwright) and checks that it computes on input.
Run:  python3 tests/browser-check.py
It serves this folder on a free local port, opens index.html, works through the W1410 form, splits, consolidation,
lineage and export, refuses bad input, and fails on any console or page error. Screenshots go to tests/.
"""
import asyncio, functools, http.server, pathlib, socketserver, threading
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
passed = failed = 0


def ok(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS', name)
    else:
        failed += 1
        print('  FAIL', name, detail)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


async def main():
    srv, port = serve()
    base = f'http://127.0.0.1:{port}/index.html'
    errors = []
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        pg = await ctx.new_page()
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        state = lambda js: pg.evaluate('() => { const S = window.__demo.state(); return ' + js + '; }')
        metric = lambda k: pg.locator(f'[data-m={k}] b').inner_text()

        print('\n1. Page loads on the engine with the sample facility')
        await pg.goto(base)
        await pg.wait_for_selector('#floor .cn')
        ok('15 trays on the floor, 8 due for W1410', await pg.locator('#floor .cn').count() == 15 and (await metric('due')).strip() == '8')

        print('\n2. Scan, look up, record')
        await pg.click('#scanBtn')
        ok('scanning picks the first due tray and shows its population', await pg.input_value('#cid') == 'C-0101' and 'P-26-031' in await pg.inner_text('#look'))
        ok('the lineage panel opens on that population', 'P-26-031' in await pg.inner_text('#lin'))
        await pg.fill('#mass', '1620')
        await pg.click('#saveBtn')
        ok('the service is saved as T-0021 and shows in the history', await state('S.tx[S.tx.length - 1].id') == 'T-0021' and 'T-0021' in await pg.inner_text('#htable'))
        ok('serviced today goes up to 2', (await metric('done')).strip() == '2')
        await pg.fill('#mass', '1630')
        await pg.click('#saveBtn')
        ok('servicing the same tray twice today is refused', 'already serviced today' in await pg.inner_text('#fErr'))

        print('\n3. Bad input is refused with reasons')
        await pg.fill('#cid', '110')
        await pg.click('#lookBtn')
        ok('"110" reads as C-0110 and says it is empty', 'C-0110 is empty' in await pg.inner_text('#look'))
        await pg.fill('#cid', '9999')
        await pg.click('#lookBtn')
        ok('an unknown container is refused', 'No container C-9999' in await pg.inner_text('#look'))
        await pg.click('#floor [data-cid="C-0103"]')
        await pg.fill('#mass', '50')
        await pg.click('#saveBtn')
        ok('a tray mass of 50 g is refused', 'Tray mass must be' in await pg.inner_text('#fErr'))
        await pg.fill('#mass', '1450')
        await pg.check('#obs input[value="Too wet"]')
        await pg.check('#obs input[value="Too dry"]')
        await pg.click('#saveBtn')
        ok('too wet and too dry together is refused', 'both too wet and too dry' in await pg.inner_text('#fErr'))
        await pg.uncheck('#obs input[value="Too wet"]')
        await pg.uncheck('#obs input[value="Too dry"]')

        print('\n4. Saved, but flagged for review')
        await pg.click('#floor [data-cid="C-0102"]')
        await pg.fill('#mass', '2000')
        await pg.check('#obs input[value="Mold"]')
        await pg.click('#saveBtn')
        ok('C-0102 at 2000 g with mold is saved as Needs review', await state('S.tx[S.tx.length - 1].status') == 'Needs review' and (await metric('rev')).strip() == '1')
        ok('the trace explains the 44% change', '44%' in await pg.inner_text('#result'))

        print('\n5. Split and consolidate')
        await pg.select_option('#sFrom', 'C-0104')
        await pg.check('#sTo input[value="C-0110"]')
        await pg.check('#sTo input[value="C-0111"]')
        await pg.click('#splitBtn')
        ok('C-0104 splits into C-0110 and C-0111 with the same population ID', await state('S.assignments.filter(a => a.population === "P-26-034" && !a.to).length') == 3)
        ok('the floor now shows P-26-034 in C-0110', 'P-26-034' in await pg.inner_text('#floor [data-cid="C-0110"]'))
        await pg.check('#mSrc input[value="C-0103"]')
        await pg.check('#mSrc input[value="C-0109"]')
        await pg.select_option('#mInto', 'C-0103')
        await pg.click('#mergeBtn')
        ok('C-0103 and C-0109 consolidate into a new population P-26-045', await state('S.populations.some(p => p.id === "P-26-045")'))
        lin = await pg.inner_text('#lin')
        ok('its lineage shows both parents and the grandparents', all(x in lin for x in ['P-26-031', 'P-26-040', 'P-26-027', 'P-26-028']), lin)
        await pg.check('#mSrc input[value="C-0201"]')
        await pg.check('#mSrc input[value="C-0105"]')
        await pg.select_option('#mInto', 'C-0112')
        await pg.click('#mergeBtn')
        ok('consolidating different species is refused', 'Different species' in await pg.inner_text('#mErr'))

        print('\n6. History, export and stage')
        await pg.select_option('#hFilter', 'p:P-26-040')
        await pg.check('#hAnc')
        ok('P-26-040 history with its parents shows 3 services', await pg.locator('#htable tbody tr').count() == 3)
        async with pg.expect_download() as dl:
            await pg.click('#csvBtn')
        d = await dl.value
        text = pathlib.Path(await d.path()).read_text()
        ok('the CSV download has a header and 3 rows', len(text.strip().split('\n')) == 4 and text.startswith('Transaction,Date and time'))
        await pg.click('#floor [data-cid="C-0201"]')
        await pg.click('#stageBtn')
        ok('advancing the stage of P-26-044 is logged', await state('S.populations.find(p => p.id === "P-26-044").stage') == 'Prepupa')
        await pg.click('#resetBtn')
        await pg.click('#scanBtn')
        await pg.fill('#mass', '1620')
        await pg.click('#saveBtn')
        await pg.locator('#console').scroll_into_view_if_needed()
        await pg.screenshot(path=str(ROOT / 'tests' / 'shot-desktop.png'))
        await pg.locator('#ops').scroll_into_view_if_needed()
        await pg.screenshot(path=str(ROOT / 'tests' / 'shot-desktop-lower.png'))

        print('\n7. Phone layout')
        mob = await br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pm = await mob.new_page()
        pm.on('pageerror', lambda e: errors.append(str(e)))
        await pm.goto(base)
        await pm.wait_for_selector('#floor .cn')
        await pm.click('#scanBtn')
        ok('no sideways scrolling at 390px wide', await pm.evaluate('document.documentElement.scrollWidth') <= 390, await pm.evaluate('document.documentElement.scrollWidth'))
        await pm.screenshot(path=str(ROOT / 'tests' / 'shot-mobile.png'))

        ok('zero console or page errors', not errors, errors)
        await br.close()
    srv.shutdown()
    print(f'\n{passed + failed} browser checks: {passed} passed, {failed} failed')
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    asyncio.run(main())
