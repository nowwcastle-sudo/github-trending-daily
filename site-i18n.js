(function(root){
"use strict";

const STORAGE_KEY="github-trending-site-locale-v1";
const SUPPORTED_LOCALES=Object.freeze(["en","ko","zh-CN","es","ja"]);

const EN={
  "document.title":"GITHUB INSIGHT",
  "feed.current":"GITHUB INSIGHT — Current repositories",
  "feed.changes":"GITHUB INSIGHT — New and re-entered repositories",
  "site.language":"Site language",
  "skip.main":"Skip to content",
  "nav.quick":"Quick navigation",
  "nav.open":"Open panel",
  "nav.close":"Close Explore sidebar",
  "nav.pin":"Pin Explore sidebar",
  "nav.explore":"Explore",
  "nav.account":"Login",
  "nav.history":"History",
  "nav.export":"Export",
  // WCAG 2.5.3 Label in Name: the rail button renders "Login", so its accessible name must start
  // with that visible label in every locale.
  "nav.ariaAccount":"Login — account and sync panel",
  "nav.ariaExplore":"Explore panel",
  "nav.ariaHistory":"History panel",
  "nav.ariaExport":"Export panel",
  "nav.titleAccount":"Login (a)",
  "nav.titleExplore":"Explore (e)",
  "nav.titleHistory":"History (h)",
  "nav.titleExport":"Export (x)",
  "nav.groups":"Panel section",
  "sidebar.title":"Dashboard menu",
  "sidebar.close":"Close panel",
  "refresh.loading":"Last refreshed: loading…",
  "refresh.next":"Next refresh: —",
  "refresh.cadence":"Refreshes every 6 hours",
  "refresh.lastAt":"Last refreshed: {time}",
  "refresh.nextAt":"Next refresh: {time}",
  "refresh.unknown":"Unavailable",
  "account.title":"Account and sync",
  "account.preparing":"Preparing sign-in.",
  "account.syncLabel":"Browser sync. {message}",
  "account.login":"Sign in with Google",
  "account.logout":"Sign out",
  "account.unavailable":"Google sync is unavailable, so changes are stored in this browser.",
  "view.aria":"Repository view",
  "view.title":"My list",
  "view.all":"All repositories",
  "view.favorites":"Favorites",
  "period.title":"Period",
  "period.aria":"Period filter",
  "period.all":"All",
  "period.daily":"Daily",
  "period.weekly":"Weekly",
  "period.monthly":"Monthly",
  "language.title":"Programming language",
  "language.all":"All languages",
  "field.title":"Field",
  "field.note":"You can select multiple fields.",
  "field.quick":"Quick filters",
  "field.excludeAi":"Exclude AI",
  "field.newOnly":"New repositories only",
  "field.aiMl":"AI and machine learning","field.webApp":"Web and app development","field.devTools":"Developer tools","field.data":"Data and databases","field.devops":"DevOps and infrastructure","field.security":"Security and privacy","field.productivity":"Apps and productivity","field.systems":"Systems and hardware","field.learning":"Learning and resources","field.unclassified":"Unclassified",
  "form.title":"Form and technology",
  "form.agent":"Agent","form.mcp":"MCP","form.pluginSkill":"Plugin and skill","form.ide":"IDE and coding tool","form.library":"Library and SDK","form.framework":"Framework","form.cli":"CLI and automation",
  "sort.title":"Sort",
  "sort.aria":"Repository sort order",
  "sort.original":"Original Trending order",
  "sort.gain":"Stars gained in selected period",
  "sort.stars":"Total stars",
  "sort.pushed":"Latest push",
  "sort.release":"Latest release",
  "sort.note":"Repositories without a value appear last.",
  "result.all":"Showing all repositories.",
  "result.clear":"Clear Explore filters",
  "hidden.title":"Manage hidden repositories",
  "hidden.restoreAll":"Restore all",
  "hidden.count":"Hidden in this browser: {count}",
  "hidden.restoreRepo":"Restore {name}",
  "hidden.didHide":"Hid {name}.",
  "hidden.didRestore":"Restored {name}.",
  "hidden.saveError":"The hidden list could not be saved, so the view was not changed.",
  "exits.title":"Recent exits",
  "exits.note":"Repositories that were in the previous confirmed list but are not in the current list.",
  "exits.empty":"No repository has left the list yet.",
  "export.title":"Export current view",
  "export.note":"Saves only public fields for the visible repositories in their current order.",
  "export.csv":"Download CSV",
  "export.json":"Download JSON",
  "export.copy":"Copy current link",
  "filter.copyLink":"Copy link",
  // The filter-bar live region is empty at rest — .filter-bar-status reserves min-height:1.45em so
  // it never collapses. The key exists so SiteI18n.apply() clears a stale copy-link message (and
  // its stale language) on every locale switch, the way export.prompt resets #exportStatus.
  "filter.statusPrompt":"",
  "export.prompt":"Choose an export format.",
  "export.linkCopied":"Copied the current-view link.",
  "export.copyFailed":"Could not copy the link to the clipboard.",
  "export.downloaded":"Downloaded {format} for the current view.",
  "export.downloadFailed":"Could not export the current view.",
  "header.resetTitle":"Reset to the initial view",
  "header.subtitle":"Today’s trending repositories with detailed, source-bound summaries — hover or tap a card",
  "header.theme":"Change theme",
  "search.aria":"Search repositories",
  "search.placeholder":"Search repositories…",
  "badges.aria":"Badge guide",
  "badges.title":"Badge guide",
  "badges.streak":"Observed on Trending on consecutive dates",
  "badges.change":"Change in total stars since the previous observation date",
  "badges.hot":"At least 1,000 stars gained in the selected period",
  "badges.new":"First observed after the baseline",
  "badges.reentered":"Returned after leaving the previous list",
  "badges.newLabel":"New",
  "badges.reenteredLabel":"Re-entered",
  "visit.heading":"Trending repositories",
  "visit.newSince":"Trending repositories · {count} new since {date}",
  "visit.noneSince":"Trending repositories · nothing new since {date}",
  "visit.badge":"New to you",
  "visit.badgeTitle":"Not in the list the last time you visited",
  "keyboard.card":"When a card is focused, press Delete to hide that repository.",
  "empty.default":"No repositories match these conditions.",
  "empty.hiddenAll":"All repositories matching these conditions are hidden.",
  "new.loading":"Loading new-repository status…",
  "new.loadingSummary":"Loading new-repository status.",
  "new.error":"New-repository status could not be loaded, so this filter is unavailable.",
  "result.count":"{count} repositories",
  "result.filters":"{count} Explore filters",
  "result.favorites":"Favorites view",
  "result.hidden":"{count} hidden",
  "empty.reset":"Reset filters",
  "empty.manage":"Manage hidden repositories",
  "common.undo":"Undo",
  "common.close":"Close",
  "common.loading":"Loading…",
  "common.restore":"Restore",
  "footer.note":"Based on GitHub Trending · summaries are AI analyses grounded in repository README files",
  "footer.subscribe":"Subscribe",
  "footer.feedCurrent":"Current repositories (Atom)",
  "footer.feedChanges":"New and re-entered (Atom)",
  "shortcuts.label":"Help",
  "shortcuts.open":"Help — keyboard shortcuts (?)",
  "shortcuts.title":"Keyboard shortcuts",
  "shortcuts.close":"Close keyboard shortcuts",
  "shortcuts.search":"Focus the search box",
  "shortcuts.explore":"Open the Explore panel",
  "shortcuts.account":"Open the Login panel",
  "shortcuts.history":"Open the History panel",
  "shortcuts.export":"Open the Export panel",
  "shortcuts.delete":"Hide the focused repository",
  "shortcuts.escape":"Close the open panel or dialog",
  "shortcuts.help":"Show this list",
  "shortcuts.disable":"Disable single-key shortcuts",
  "shortcuts.disableNote":"Slash, question mark, Escape and Delete keep working.",
  "scroll.top":"Back to top",
  "readme.dialog":"README viewer",
  "readme.default":"Default",
  "readme.github":"GitHub ↗",
  "readme.close":"Close README viewer",
  "readme.loading":"Loading…",
  "readme.view":"View README",
  "readme.unavailable":"README is unavailable.",
  "readme.direct":"View directly on GitHub ↗",
  "tooltip.dialog":"Repository summary",
  "tooltip.unavailable":"Summary is unavailable for the selected site language.",
  "tooltip.held":"Summary is being verified. Open the README for details.",
  "tooltip.heldRetry":"Retried at the next refresh (every 6 hours).",
  "tooltip.language":"Summary language",
  "tooltip.aiNote":"AI-generated from the verified repository README",
  "tooltip.goal":"Project goal",
  "tooltip.usage":"How to use",
  "tooltip.pros":"Strengths",
  "tooltip.cons":"Cautions",
  "tooltip.fit":"Best fit",
  "tooltip.trend":"Trend note",
  "tooltip.hide":"Not interested",
  "repo.contributors":"contributors",
  "repo.issues":"open issues and PRs",
  "repo.commit":"commit",
  "repo.release":"release",
  "repo.repository":"repository",
  "repo.aria":"{name} repository",
  "repo.favorite":"Favorite",
  // WCAG 4.1.2: 52 cards each carry one of these, so the name has to identify its own repository.
  "repo.favoriteAdd":"Add {name} to favorites",
  "repo.favoriteRemove":"Remove {name} from favorites",
  "repo.forks":"forks",
  "repo.totalStars":"total stars",
  "classification.form":"Form","classification.field":"Field and technology","classification.ai":"AI related",
  "history.loading":"📈 Loading star history…","history.failed":"📈 Star history could not be loaded",
  "history.title":"Star history","history.explanation":"Total stars observed directly by this site (every 30 minutes) · the dashed line marks anchors back-calculated from GitHub Trending period totals","history.observedSince":"Observing since","history.ariaTrend":"Star trend","history.waiting":"Waiting for the first observation","history.singleObservation":"1 observation",
  "period.recent":"Recent",
  "period.today":"Today",
  "period.thisWeek":"This week",
  "period.thisMonth":"This month"
};

const KO={
  "document.title":"GITHUB INSIGHT","feed.current":"GITHUB INSIGHT — Current repositories","feed.changes":"GITHUB INSIGHT — New and re-entered repositories",
  "site.language":"사이트 언어","skip.main":"본문으로 건너뛰기","nav.quick":"빠른 탐색","nav.open":"패널 열기","nav.close":"탐색 사이드바 닫기","nav.pin":"탐색 사이드바 고정","nav.explore":"탐색",
  "nav.account":"로그인","nav.history":"이력","nav.export":"내보내기","nav.ariaAccount":"로그인 — 계정·동기화 패널","nav.ariaExplore":"탐색 패널","nav.ariaHistory":"이력 패널","nav.ariaExport":"내보내기 패널","nav.titleAccount":"로그인 (a)","nav.titleExplore":"탐색 (e)","nav.titleHistory":"이력 (h)","nav.titleExport":"내보내기 (x)","nav.groups":"패널 구획","filter.copyLink":"링크 복사","filter.statusPrompt":"","tooltip.heldRetry":"다음 갱신(6시간마다) 때 다시 시도합니다.",
  "sidebar.title":"대시보드 메뉴","sidebar.close":"패널 닫기","refresh.loading":"최근 갱신 시각: 불러오는 중…","refresh.next":"다음 갱신 시각: —","refresh.cadence":"6시간마다 갱신",
  "account.title":"계정과 동기화","account.preparing":"로그인 준비 중이에요.","account.syncLabel":"브라우저 동기화. {message}","account.login":"Google로 로그인","account.logout":"로그아웃","account.unavailable":"Google 동기화를 사용할 수 없어 이 브라우저에 저장합니다.",
  "view.aria":"저장소 보기","view.title":"내 목록","view.all":"전체 저장소","view.favorites":"즐겨찾기","period.title":"기간","period.aria":"기간 필터","period.all":"전체","period.daily":"일간","period.weekly":"주간","period.monthly":"월간",
  "language.title":"프로그래밍 언어","language.all":"모든 언어","field.title":"분야","field.note":"여러 분야를 함께 선택할 수 있습니다.","field.quick":"빠른 필터","field.excludeAi":"AI 분야 제외","field.newOnly":"신규 저장소만","field.aiMl":"AI·머신러닝","field.webApp":"웹·앱 개발","field.devTools":"개발 도구","field.data":"데이터·DB","field.devops":"DevOps·인프라","field.security":"보안·프라이버시","field.productivity":"앱·생산성","field.systems":"시스템·하드웨어","field.learning":"학습·자료","field.unclassified":"미분류","form.title":"형태·기술","form.agent":"Agent","form.mcp":"MCP","form.pluginSkill":"Plugin·Skill","form.ide":"IDE·코딩 도구","form.library":"Library·SDK","form.framework":"Framework","form.cli":"CLI·Automation",
  "sort.title":"정렬","sort.aria":"저장소 정렬","sort.original":"Trending 원래 순서","sort.gain":"선택 기간 스타 증가","sort.stars":"총 스타","sort.pushed":"최근 푸시","sort.release":"최근 릴리스","sort.note":"값이 없는 저장소는 뒤에 표시됩니다.",
  "result.all":"전체 저장소를 표시합니다.","result.clear":"탐색 필터 지우기","result.count":"저장소 {count}개","result.filters":"탐색 필터 {count}개","result.favorites":"즐겨찾기 보기","result.hidden":"숨김 {count}개","hidden.title":"숨긴 저장소 관리","hidden.restoreAll":"모두 복구","hidden.count":"이 브라우저에서 {count}개를 숨겼습니다.","hidden.restoreRepo":"{name} 복구","hidden.didHide":"{name} 저장소를 숨겼습니다.","hidden.didRestore":"{name} 저장소를 다시 표시했습니다.","hidden.saveError":"숨김 목록을 저장할 수 없어 화면을 변경하지 않았습니다.","exits.title":"최근 이탈","exits.note":"직전 확정 목록에는 있었지만 현재 목록에는 없는 저장소입니다.","exits.empty":"아직 목록에서 이탈한 저장소가 없습니다.",
  "export.title":"현재 보기 내보내기","export.note":"화면에 보이는 순서와 저장소만 공개 필드로 저장합니다.","export.csv":"CSV 다운로드","export.json":"JSON 다운로드","export.copy":"현재 링크 복사","export.prompt":"내보낼 형식을 선택하세요.","export.linkCopied":"현재 보기 링크를 복사했습니다.","export.copyFailed":"클립보드에 링크를 복사하지 못했습니다.","export.downloaded":"현재 보기를 {format} 파일로 저장했습니다.","export.downloadFailed":"현재 보기를 내보내지 못했습니다.",
  "header.resetTitle":"처음 화면으로 초기화","header.subtitle":"README에 근거한 상세 요약이 담긴 오늘의 트렌딩 저장소 — 카드를 가리키거나 탭해보세요","header.theme":"테마 전환","search.aria":"저장소 검색","search.placeholder":"저장소 검색…",
  "badges.aria":"배지 안내","badges.title":"배지 안내","badges.streak":"연속된 날짜에 Trending에서 관측","badges.change":"직전 관측일 대비 총 스타 변화","badges.hot":"선택 기간 스타 증가 1,000 이상","badges.new":"baseline 이후 처음 관측","badges.reentered":"직전 목록에서 빠졌다가 다시 등장","badges.newLabel":"신규","badges.reenteredLabel":"재진입","visit.heading":"트렌딩 저장소","visit.newSince":"트렌딩 저장소 · {date} 이후 새로 {count}개","visit.noneSince":"트렌딩 저장소 · {date} 이후 새로운 저장소 없음","visit.badge":"처음 봄","visit.badgeTitle":"지난 방문 때 목록에 없던 저장소",
  "keyboard.card":"카드에 초점이 있을 때 Delete 키를 누르면 저장소를 관심 없음 처리할 수 있습니다.","empty.default":"조건에 맞는 저장소가 없어요.","empty.hiddenAll":"현재 조건의 저장소를 모두 숨겼어요.","new.loading":"신규 상태를 불러오는 중…","new.loadingSummary":"신규 상태를 불러오는 중입니다.","new.error":"신규 상태를 불러오지 못해 필터를 적용할 수 없습니다.","empty.reset":"필터 초기화","empty.manage":"숨긴 저장소 관리","common.undo":"되돌리기","common.close":"닫기","common.loading":"불러오는 중…","common.restore":"복구",
  "footer.note":"GitHub Trending 기준 · 요약은 저장소 README에 근거한 AI 분석입니다","footer.subscribe":"구독","footer.feedCurrent":"현재 목록 (Atom)","footer.feedChanges":"신규·재진입 (Atom)","shortcuts.label":"도움말","shortcuts.open":"도움말 — 단축키 (?)","shortcuts.title":"단축키","shortcuts.close":"단축키 닫기","shortcuts.search":"검색창으로 이동","shortcuts.explore":"탐색 패널 열기","shortcuts.account":"로그인 패널 열기","shortcuts.history":"이력 패널 열기","shortcuts.export":"내보내기 패널 열기","shortcuts.delete":"선택한 저장소 숨기기","shortcuts.escape":"열린 패널·대화상자 닫기","shortcuts.help":"이 목록 보기","shortcuts.disable":"한 글자 단축키 사용 안 함","shortcuts.disableNote":"슬래시(/), 물음표(?), Esc, Delete는 계속 동작합니다.","scroll.top":"페이지 맨 위로 이동","readme.dialog":"README 뷰어","readme.default":"기본","readme.github":"GitHub ↗","readme.close":"README 뷰어 닫기","readme.loading":"불러오는 중…","readme.view":"README 전체 보기","readme.unavailable":"README를 확인할 수 없어요.","readme.direct":"GitHub에서 직접 보기 ↗",
  "tooltip.dialog":"저장소 요약","tooltip.unavailable":"선택한 사이트 언어의 요약을 확인할 수 없어요.","tooltip.held":"요약 검증 중입니다. 자세한 내용은 README를 여세요.","tooltip.language":"요약 언어","tooltip.aiNote":"검증된 저장소 README를 바탕으로 AI가 생성한 요약","tooltip.goal":"프로젝트 목표","tooltip.usage":"실행 방법","tooltip.pros":"장점","tooltip.cons":"단점·주의점","tooltip.fit":"어울리는 상황","tooltip.trend":"트렌드 한 줄 평","tooltip.hide":"관심 없음",
  "repo.contributors":"기여자","repo.issues":"열린 이슈·PR","repo.commit":"커밋","repo.release":"릴리스","repo.repository":"저장소","repo.aria":"{name} 저장소","repo.favorite":"즐겨찾기","repo.favoriteAdd":"{name} 즐겨찾기 추가","repo.favoriteRemove":"{name} 즐겨찾기 해제","repo.forks":"forks","repo.totalStars":"total stars","classification.form":"형태","classification.field":"분야·기술","classification.ai":"AI 관련","history.loading":"📈 스타 추이를 불러오는 중…","history.failed":"📈 스타 추이를 불러오지 못했어요","history.title":"스타 히스토리","history.explanation":"이 사이트가 직접 관측한 총 스타(30분 간격) · 점선은 GitHub Trending 기간 집계로 역산한 앵커","history.observedSince":"관측 시작","history.ariaTrend":"스타 추이","history.waiting":"관측 시작 대기","history.singleObservation":"관측 1회","period.recent":"최근","period.today":"오늘","period.thisWeek":"이번 주","period.thisMonth":"이번 달","refresh.lastAt":"최근 갱신 시각: {time}","refresh.nextAt":"다음 갱신 시각: {time}","refresh.unknown":"확인할 수 없음"
};

const ZH={
  "document.title":"GITHUB INSIGHT","feed.current":"GITHUB INSIGHT — Current repositories","feed.changes":"GITHUB INSIGHT — New and re-entered repositories",
  "site.language":"网站语言","skip.main":"跳到主要内容","nav.quick":"快速导航","nav.open":"打开面板","nav.close":"关闭探索侧栏","nav.pin":"固定探索侧栏","nav.explore":"探索",
  "nav.account":"登录","nav.history":"历史","nav.export":"导出","nav.ariaAccount":"登录 — 账户与同步面板","nav.ariaExplore":"探索面板","nav.ariaHistory":"历史面板","nav.ariaExport":"导出面板","nav.titleAccount":"登录 (a)","nav.titleExplore":"探索 (e)","nav.titleHistory":"历史 (h)","nav.titleExport":"导出 (x)","nav.groups":"面板分区","filter.copyLink":"复制链接","filter.statusPrompt":"","tooltip.heldRetry":"将在下次刷新（每6小时一次）时重试。",
  "sidebar.title":"面板菜单","sidebar.close":"关闭面板","refresh.loading":"最近更新：加载中…","refresh.next":"下次更新：—","refresh.cadence":"每6小时更新一次",
  "account.title":"账户与同步","account.preparing":"正在准备登录。","account.syncLabel":"浏览器同步。{message}","account.login":"使用 Google 登录","account.logout":"退出登录",
  "view.aria":"仓库视图","view.title":"我的列表","view.all":"全部仓库","view.favorites":"收藏","period.title":"时间范围","period.aria":"时间范围筛选","period.all":"全部","period.daily":"每日","period.weekly":"每周","period.monthly":"每月",
  "language.title":"编程语言","language.all":"所有语言","field.title":"领域","field.note":"可同时选择多个领域。","field.quick":"快速筛选","field.excludeAi":"排除 AI","field.newOnly":"仅新仓库","form.title":"形态与技术",
  "sort.title":"排序","sort.aria":"仓库排序","sort.original":"Trending 原始顺序","sort.gain":"所选期间新增星标","sort.stars":"总星标","sort.pushed":"最近推送","sort.release":"最近发布","sort.note":"无对应值的仓库排在最后。",
  "result.all":"正在显示全部仓库。","result.clear":"清除探索筛选","hidden.title":"管理隐藏仓库","hidden.restoreAll":"全部恢复","exits.title":"最近离榜","exits.note":"上一份确认列表中存在、但当前列表中不存在的仓库。","exits.empty":"还没有仓库离开列表。",
  "export.title":"导出当前视图","export.note":"仅按当前顺序保存可见仓库的公开字段。","export.csv":"下载 CSV","export.json":"下载 JSON","export.copy":"复制当前链接","export.prompt":"请选择导出格式。",
  "header.resetTitle":"重置为初始视图","header.subtitle":"今日热门仓库与基于来源的详细摘要 — 悬停或轻触卡片","header.theme":"切换主题","search.aria":"搜索仓库","search.placeholder":"搜索仓库…",
  "badges.aria":"徽章说明","badges.title":"徽章说明","badges.streak":"连续多日出现在 Trending","badges.change":"自上次观测日起总星标变化","badges.hot":"所选期间新增至少 1,000 个星标","badges.new":"基线后首次观测","badges.reentered":"离开上一列表后重新上榜","badges.newLabel":"新增","badges.reenteredLabel":"重新上榜","visit.heading":"趋势仓库","visit.newSince":"趋势仓库 · 自 {date} 起新增 {count} 个","visit.noneSince":"趋势仓库 · 自 {date} 起没有新增","visit.badge":"你的新发现","visit.badgeTitle":"上次访问时不在列表中",
  "keyboard.card":"卡片获得焦点时，按 Delete 可隐藏该仓库。","empty.default":"没有符合条件的仓库。","empty.reset":"重置筛选","empty.manage":"管理隐藏仓库","common.undo":"撤销","common.close":"关闭","common.loading":"加载中…","common.restore":"恢复",
  "footer.note":"基于 GitHub Trending · 摘要是以仓库 README 为依据的 AI 分析","footer.subscribe":"订阅","footer.feedCurrent":"当前仓库 (Atom)","footer.feedChanges":"新增与再次进入 (Atom)","shortcuts.label":"帮助","shortcuts.open":"帮助 — 键盘快捷键 (?)","shortcuts.title":"键盘快捷键","shortcuts.close":"关闭键盘快捷键","shortcuts.search":"聚焦搜索框","shortcuts.explore":"打开探索面板","shortcuts.account":"打开登录面板","shortcuts.history":"打开历史面板","shortcuts.export":"打开导出面板","shortcuts.delete":"隐藏选中的仓库","shortcuts.escape":"关闭打开的面板或对话框","shortcuts.help":"显示此列表","shortcuts.disable":"停用单键快捷键","shortcuts.disableNote":"斜杠、问号、Esc 和 Delete 仍然有效。","scroll.top":"返回顶部","readme.dialog":"README 查看器","readme.default":"默认","readme.github":"GitHub ↗","readme.close":"关闭 README 查看器","readme.loading":"加载中…","readme.view":"查看 README","readme.unavailable":"README 暂不可用。","readme.direct":"直接在 GitHub 查看 ↗",
  "tooltip.dialog":"仓库摘要","tooltip.unavailable":"所选网站语言的摘要不可用。","tooltip.held":"摘要正在验证中。详情请查看 README。","tooltip.aiNote":"由 AI 根据已验证的仓库 README 生成","tooltip.goal":"项目目标","tooltip.usage":"使用方法","tooltip.pros":"优点","tooltip.cons":"注意事项","tooltip.fit":"适用场景","tooltip.trend":"趋势说明","tooltip.hide":"不感兴趣",
  "repo.contributors":"贡献者","repo.issues":"未关闭的问题与 PR","repo.commit":"提交","repo.release":"发布","repo.repository":"仓库","period.recent":"最近","period.today":"今天","period.thisWeek":"本周","period.thisMonth":"本月",
  "account.unavailable":"Google 同步不可用，因此更改将保存在此浏览器中。","refresh.lastAt":"最近更新：{time}","refresh.nextAt":"下次更新：{time}","refresh.unknown":"无法确认",
  "field.aiMl":"AI 与机器学习","field.webApp":"Web 与应用开发","field.devTools":"开发工具","field.data":"数据与数据库","field.devops":"DevOps 与基础设施","field.security":"安全与隐私","field.productivity":"应用与生产力","field.systems":"系统与硬件","field.learning":"学习与资料","field.unclassified":"未分类",
  "form.agent":"Agent","form.mcp":"MCP","form.pluginSkill":"插件与技能","form.ide":"IDE 与编码工具","form.library":"库与 SDK","form.framework":"框架","form.cli":"CLI 与自动化",
  "hidden.count":"此浏览器中已隐藏 {count} 个。","hidden.restoreRepo":"恢复 {name}","hidden.didHide":"已隐藏 {name}。","hidden.didRestore":"已恢复 {name}。","hidden.saveError":"无法保存隐藏列表，因此视图未更改。",
  "export.linkCopied":"已复制当前视图链接。","export.copyFailed":"无法将链接复制到剪贴板。","export.downloaded":"已下载当前视图的 {format} 文件。","export.downloadFailed":"无法导出当前视图。",
  "empty.hiddenAll":"符合当前条件的仓库均已隐藏。","new.loading":"正在加载新仓库状态…","new.loadingSummary":"正在加载新仓库状态。","new.error":"无法加载新仓库状态，因此该筛选不可用。",
  "result.count":"{count} 个仓库","result.filters":"{count} 个探索筛选","result.favorites":"收藏视图","result.hidden":"隐藏 {count} 个","tooltip.language":"摘要语言",
  "repo.aria":"{name} 仓库","repo.favorite":"收藏","repo.favoriteAdd":"将 {name} 添加到收藏","repo.favoriteRemove":"从收藏中移除 {name}","repo.forks":"fork","repo.totalStars":"总星标",
  "classification.form":"形态","classification.field":"领域与技术","classification.ai":"AI 相关","history.loading":"📈 正在加载星标历史…","history.failed":"📈 无法加载星标历史","history.title":"星标历史","history.explanation":"本站直接观测到的星标总数（每 30 分钟一次）· 虚线为根据 GitHub Trending 周期增量反推的锚点","history.observedSince":"观测起始","history.ariaTrend":"星标走势","history.waiting":"等待首次观测","history.singleObservation":"观测 1 次"
};

const ES={
  "document.title":"GITHUB INSIGHT","feed.current":"GITHUB INSIGHT — Current repositories","feed.changes":"GITHUB INSIGHT — New and re-entered repositories",
  "site.language":"Idioma del sitio","skip.main":"Saltar al contenido","nav.quick":"Navegación rápida","nav.open":"Abrir panel","nav.close":"Cerrar barra Explorar","nav.pin":"Fijar barra Explorar","nav.explore":"Explorar",
  "nav.account":"Iniciar sesión","nav.history":"Historial","nav.export":"Exportar","nav.ariaAccount":"Iniciar sesión — Panel de cuenta y sincronización","nav.ariaExplore":"Panel de exploración","nav.ariaHistory":"Panel de historial","nav.ariaExport":"Panel de exportación","nav.titleAccount":"Iniciar sesión (a)","nav.titleExplore":"Explorar (e)","nav.titleHistory":"Historial (h)","nav.titleExport":"Exportar (x)","nav.groups":"Sección del panel","filter.copyLink":"Copiar enlace","filter.statusPrompt":"","tooltip.heldRetry":"Se reintentará en la próxima actualización (cada 6 horas).",
  "sidebar.title":"Menú del panel","sidebar.close":"Cerrar panel","refresh.loading":"Última actualización: cargando…","refresh.next":"Próxima actualización: —","refresh.cadence":"Se actualiza cada 6 horas",
  "account.title":"Cuenta y sincronización","account.preparing":"Preparando el inicio de sesión.","account.syncLabel":"Sincronización del navegador. {message}","account.login":"Iniciar sesión con Google","account.logout":"Cerrar sesión",
  "view.aria":"Vista de repositorios","view.title":"Mi lista","view.all":"Todos los repositorios","view.favorites":"Favoritos","period.title":"Periodo","period.aria":"Filtro de periodo","period.all":"Todo","period.daily":"Diario","period.weekly":"Semanal","period.monthly":"Mensual",
  "language.title":"Lenguaje de programación","language.all":"Todos los lenguajes","field.title":"Área","field.note":"Puedes seleccionar varias áreas.","field.quick":"Filtros rápidos","field.excludeAi":"Excluir IA","field.newOnly":"Solo repositorios nuevos","form.title":"Formato y tecnología",
  "sort.title":"Ordenar","sort.aria":"Orden de repositorios","sort.original":"Orden original de Trending","sort.gain":"Estrellas ganadas en el periodo","sort.stars":"Estrellas totales","sort.pushed":"Último push","sort.release":"Última versión","sort.note":"Los repositorios sin valor aparecen al final.",
  "result.all":"Mostrando todos los repositorios.","result.clear":"Borrar filtros de Explorar","hidden.title":"Gestionar repositorios ocultos","hidden.restoreAll":"Restaurar todo","exits.title":"Salidas recientes","exits.note":"Repositorios presentes en la lista confirmada anterior, pero no en la actual.","exits.empty":"Todavía ningún repositorio ha salido de la lista.",
  "export.title":"Exportar vista actual","export.note":"Guarda solo campos públicos de los repositorios visibles en su orden actual.","export.csv":"Descargar CSV","export.json":"Descargar JSON","export.copy":"Copiar enlace actual","export.prompt":"Elige un formato de exportación.",
  "header.resetTitle":"Restablecer la vista inicial","header.subtitle":"Repositorios en tendencia con resúmenes detallados y vinculados a la fuente — pasa el cursor o toca una tarjeta","header.theme":"Cambiar tema","search.aria":"Buscar repositorios","search.placeholder":"Buscar repositorios…",
  "badges.aria":"Guía de insignias","badges.title":"Guía de insignias","badges.streak":"Observado en Trending durante días consecutivos","badges.change":"Cambio de estrellas totales desde la observación anterior","badges.hot":"Al menos 1.000 estrellas ganadas en el periodo","badges.new":"Primera observación después de la línea base","badges.reentered":"Volvió después de salir de la lista anterior","badges.newLabel":"Nuevo","badges.reenteredLabel":"Reincorporado","visit.heading":"Repositorios en tendencia","visit.newSince":"Repositorios en tendencia · {count} nuevos desde el {date}","visit.noneSince":"Repositorios en tendencia · nada nuevo desde el {date}","visit.badge":"Nuevo para ti","visit.badgeTitle":"No estaba en la lista en tu última visita",
  "keyboard.card":"Con una tarjeta enfocada, pulsa Delete para ocultar ese repositorio.","empty.default":"Ningún repositorio coincide con estas condiciones.","empty.reset":"Restablecer filtros","empty.manage":"Gestionar repositorios ocultos","common.undo":"Deshacer","common.close":"Cerrar","common.loading":"Cargando…","common.restore":"Restaurar",
  "footer.note":"Basado en GitHub Trending · los resúmenes son análisis de IA fundamentados en el README del repositorio","footer.subscribe":"Suscribirse","footer.feedCurrent":"Repositorios actuales (Atom)","footer.feedChanges":"Nuevos y reincorporados (Atom)","shortcuts.label":"Ayuda","shortcuts.open":"Ayuda — atajos de teclado (?)","shortcuts.title":"Atajos de teclado","shortcuts.close":"Cerrar atajos de teclado","shortcuts.search":"Enfocar el cuadro de búsqueda","shortcuts.explore":"Abrir el panel de exploración","shortcuts.account":"Abrir el panel de inicio de sesión","shortcuts.history":"Abrir el panel de historial","shortcuts.export":"Abrir el panel de exportación","shortcuts.delete":"Ocultar el repositorio enfocado","shortcuts.escape":"Cerrar el panel o diálogo abierto","shortcuts.help":"Mostrar esta lista","shortcuts.disable":"Desactivar los atajos de una sola tecla","shortcuts.disableNote":"La barra, el signo de interrogación, Escape y Suprimir siguen funcionando.","scroll.top":"Volver arriba","readme.dialog":"Visor de README","readme.default":"Predeterminado","readme.github":"GitHub ↗","readme.close":"Cerrar visor de README","readme.loading":"Cargando…","readme.view":"Ver README","readme.unavailable":"El README no está disponible.","readme.direct":"Ver directamente en GitHub ↗",
  "tooltip.dialog":"Resumen del repositorio","tooltip.unavailable":"El resumen no está disponible en el idioma seleccionado del sitio.","tooltip.held":"El resumen se está verificando. Abra el README para más detalles.","tooltip.aiNote":"Resumen generado por IA a partir del README verificado del repositorio","tooltip.goal":"Objetivo del proyecto","tooltip.usage":"Cómo usarlo","tooltip.pros":"Ventajas","tooltip.cons":"Precauciones","tooltip.fit":"Uso recomendado","tooltip.trend":"Nota de tendencia","tooltip.hide":"No me interesa",
  "repo.contributors":"colaboradores","repo.issues":"incidencias y PR abiertos","repo.commit":"commit","repo.release":"versión","repo.repository":"repositorio","period.recent":"Reciente","period.today":"Hoy","period.thisWeek":"Esta semana","period.thisMonth":"Este mes",
  "account.unavailable":"La sincronización con Google no está disponible; los cambios se guardan en este navegador.","refresh.lastAt":"Última actualización: {time}","refresh.nextAt":"Próxima actualización: {time}","refresh.unknown":"No disponible",
  "field.aiMl":"IA y aprendizaje automático","field.webApp":"Desarrollo web y de aplicaciones","field.devTools":"Herramientas de desarrollo","field.data":"Datos y bases de datos","field.devops":"DevOps e infraestructura","field.security":"Seguridad y privacidad","field.productivity":"Aplicaciones y productividad","field.systems":"Sistemas y hardware","field.learning":"Aprendizaje y recursos","field.unclassified":"Sin clasificar",
  "form.agent":"Agente","form.mcp":"MCP","form.pluginSkill":"Plugin y skill","form.ide":"IDE y herramienta de código","form.library":"Biblioteca y SDK","form.framework":"Framework","form.cli":"CLI y automatización",
  "hidden.count":"Ocultos en este navegador: {count}","hidden.restoreRepo":"Restaurar {name}","hidden.didHide":"Se ocultó {name}.","hidden.didRestore":"Se restauró {name}.","hidden.saveError":"No se pudo guardar la lista de ocultos; la vista no cambió.",
  "export.linkCopied":"Se copió el enlace de la vista actual.","export.copyFailed":"No se pudo copiar el enlace al portapapeles.","export.downloaded":"Se descargó la vista actual en {format}.","export.downloadFailed":"No se pudo exportar la vista actual.",
  "empty.hiddenAll":"Todos los repositorios que coinciden están ocultos.","new.loading":"Cargando el estado de repositorios nuevos…","new.loadingSummary":"Cargando el estado de repositorios nuevos.","new.error":"No se pudo cargar el estado de repositorios nuevos; este filtro no está disponible.",
  "result.count":"{count} repositorios","result.filters":"{count} filtros de Explorar","result.favorites":"Vista de favoritos","result.hidden":"{count} ocultos","tooltip.language":"Idioma del resumen",
  "repo.aria":"Repositorio {name}","repo.favorite":"Favorito","repo.favoriteAdd":"Añadir {name} a favoritos","repo.favoriteRemove":"Quitar {name} de favoritos","repo.forks":"forks","repo.totalStars":"estrellas totales",
  "classification.form":"Formato","classification.field":"Área y tecnología","classification.ai":"Relacionado con IA","history.loading":"📈 Cargando historial de estrellas…","history.failed":"📈 No se pudo cargar el historial de estrellas","history.title":"Historial de estrellas","history.explanation":"Total de estrellas observadas directamente por este sitio (cada 30 minutos) · la línea discontinua marca anclas calculadas a partir de los totales por periodo de GitHub Trending","history.observedSince":"Observando desde","history.ariaTrend":"Tendencia de estrellas","history.waiting":"Esperando la primera observación","history.singleObservation":"1 observación"
};

const JA={
  "document.title":"GITHUB INSIGHT","feed.current":"GITHUB INSIGHT — Current repositories","feed.changes":"GITHUB INSIGHT — New and re-entered repositories",
  "site.language":"サイトの言語","skip.main":"本文へスキップ","nav.quick":"クイックナビゲーション","nav.open":"パネルを開く","nav.close":"探索サイドバーを閉じる","nav.pin":"探索サイドバーを固定","nav.explore":"探索",
  "nav.account":"ログイン","nav.history":"履歴","nav.export":"エクスポート","nav.ariaAccount":"ログイン — アカウント・同期パネル","nav.ariaExplore":"探索パネル","nav.ariaHistory":"履歴パネル","nav.ariaExport":"エクスポートパネル","nav.titleAccount":"ログイン (a)","nav.titleExplore":"探索 (e)","nav.titleHistory":"履歴 (h)","nav.titleExport":"エクスポート (x)","nav.groups":"パネルセクション","filter.copyLink":"リンクをコピー","filter.statusPrompt":"","tooltip.heldRetry":"次回の更新（6時間ごと）で再試行します。",
  "sidebar.title":"ダッシュボードメニュー","sidebar.close":"パネルを閉じる","refresh.loading":"最終更新：読み込み中…","refresh.next":"次回更新：—","refresh.cadence":"6時間ごとに更新",
  "account.title":"アカウントと同期","account.preparing":"ログインを準備しています。","account.syncLabel":"ブラウザー同期。{message}","account.login":"Googleでログイン","account.logout":"ログアウト",
  "view.aria":"リポジトリ表示","view.title":"マイリスト","view.all":"すべてのリポジトリ","view.favorites":"お気に入り","period.title":"期間","period.aria":"期間フィルター","period.all":"すべて","period.daily":"日間","period.weekly":"週間","period.monthly":"月間",
  "language.title":"プログラミング言語","language.all":"すべての言語","field.title":"分野","field.note":"複数の分野を選択できます。","field.quick":"クイックフィルター","field.excludeAi":"AIを除外","field.newOnly":"新規リポジトリのみ","form.title":"形態・技術",
  "sort.title":"並び替え","sort.aria":"リポジトリの並び順","sort.original":"Trendingの元の順序","sort.gain":"選択期間のスター増加","sort.stars":"総スター数","sort.pushed":"最新プッシュ","sort.release":"最新リリース","sort.note":"値がないリポジトリは最後に表示されます。",
  "result.all":"すべてのリポジトリを表示しています。","result.clear":"探索フィルターをクリア","hidden.title":"非表示リポジトリを管理","hidden.restoreAll":"すべて復元","exits.title":"最近の離脱","exits.note":"前回の確定リストにはあり、現在のリストにはないリポジトリです。","exits.empty":"リストから外れたリポジトリはまだありません。",
  "export.title":"現在の表示をエクスポート","export.note":"表示中のリポジトリの公開フィールドだけを現在の順序で保存します。","export.csv":"CSVをダウンロード","export.json":"JSONをダウンロード","export.copy":"現在のリンクをコピー","export.prompt":"エクスポート形式を選択してください。",
  "header.resetTitle":"初期表示に戻す","header.subtitle":"出典に基づく詳細要約付きの今日のトレンドリポジトリ — カードにカーソルを合わせるかタップ","header.theme":"テーマを変更","search.aria":"リポジトリを検索","search.placeholder":"リポジトリを検索…",
  "badges.aria":"バッジガイド","badges.title":"バッジガイド","badges.streak":"連続した日付でTrendingに掲載","badges.change":"前回観測日からの総スター数の変化","badges.hot":"選択期間に1,000以上のスター増加","badges.new":"ベースライン後に初めて観測","badges.reentered":"前回リストから外れた後に再登場","badges.newLabel":"新規","badges.reenteredLabel":"再登場","visit.heading":"トレンドのリポジトリ","visit.newSince":"トレンドのリポジトリ · {date} 以降の新着 {count} 件","visit.noneSince":"トレンドのリポジトリ · {date} 以降の新着なし","visit.badge":"あなたに新着","visit.badgeTitle":"前回の訪問時には一覧になかったリポジトリ",
  "keyboard.card":"カードにフォーカスがあるとき、Deleteキーでそのリポジトリを非表示にできます。","empty.default":"条件に一致するリポジトリはありません。","empty.reset":"フィルターをリセット","empty.manage":"非表示リポジトリを管理","common.undo":"元に戻す","common.close":"閉じる","common.loading":"読み込み中…","common.restore":"復元",
  "footer.note":"GitHub Trendingを基準 · 要約はリポジトリREADMEに基づくAI分析です","footer.subscribe":"購読","footer.feedCurrent":"現在のリポジトリ (Atom)","footer.feedChanges":"新規・再登場 (Atom)","shortcuts.label":"ヘルプ","shortcuts.open":"ヘルプ — キーボードショートカット (?)","shortcuts.title":"キーボードショートカット","shortcuts.close":"キーボードショートカットを閉じる","shortcuts.search":"検索ボックスにフォーカス","shortcuts.explore":"探索パネルを開く","shortcuts.account":"ログインパネルを開く","shortcuts.history":"履歴パネルを開く","shortcuts.export":"エクスポートパネルを開く","shortcuts.delete":"選択中のリポジトリを非表示","shortcuts.escape":"開いているパネル・ダイアログを閉じる","shortcuts.help":"この一覧を表示","shortcuts.disable":"1キーのショートカットを無効にする","shortcuts.disableNote":"スラッシュ、疑問符、Esc、Delete は引き続き使えます。","scroll.top":"ページ上部へ","readme.dialog":"READMEビューアー","readme.default":"既定","readme.github":"GitHub ↗","readme.close":"READMEビューアーを閉じる","readme.loading":"読み込み中…","readme.view":"READMEを見る","readme.unavailable":"READMEを利用できません。","readme.direct":"GitHubで直接見る ↗",
  "tooltip.dialog":"リポジトリ要約","tooltip.unavailable":"選択したサイト言語の要約を利用できません。","tooltip.held":"要約を検証中です。詳細は README をご覧ください。","tooltip.aiNote":"検証済みのリポジトリREADMEを基にAIが生成した要約","tooltip.goal":"プロジェクトの目的","tooltip.usage":"使い方","tooltip.pros":"長所","tooltip.cons":"注意点","tooltip.fit":"適した用途","tooltip.trend":"トレンドメモ","tooltip.hide":"興味なし",
  "repo.contributors":"コントリビューター","repo.issues":"未解決のIssueとPR","repo.commit":"コミット","repo.release":"リリース","repo.repository":"リポジトリ","period.recent":"最近","period.today":"今日","period.thisWeek":"今週","period.thisMonth":"今月",
  "account.unavailable":"Google同期を利用できないため、変更はこのブラウザーに保存されます。","refresh.lastAt":"最終更新：{time}","refresh.nextAt":"次回更新：{time}","refresh.unknown":"確認できません",
  "field.aiMl":"AI・機械学習","field.webApp":"Web・アプリ開発","field.devTools":"開発ツール","field.data":"データ・データベース","field.devops":"DevOps・インフラ","field.security":"セキュリティ・プライバシー","field.productivity":"アプリ・生産性","field.systems":"システム・ハードウェア","field.learning":"学習・資料","field.unclassified":"未分類",
  "form.agent":"エージェント","form.mcp":"MCP","form.pluginSkill":"プラグイン・スキル","form.ide":"IDE・コーディングツール","form.library":"ライブラリ・SDK","form.framework":"フレームワーク","form.cli":"CLI・自動化",
  "hidden.count":"このブラウザーで{count}件を非表示にしています。","hidden.restoreRepo":"{name}を復元","hidden.didHide":"{name}を非表示にしました。","hidden.didRestore":"{name}を復元しました。","hidden.saveError":"非表示リストを保存できなかったため、表示は変更していません。",
  "export.linkCopied":"現在の表示リンクをコピーしました。","export.copyFailed":"リンクをクリップボードにコピーできませんでした。","export.downloaded":"現在の表示を{format}でダウンロードしました。","export.downloadFailed":"現在の表示をエクスポートできませんでした。",
  "empty.hiddenAll":"現在の条件に一致するリポジトリはすべて非表示です。","new.loading":"新規リポジトリの状態を読み込み中…","new.loadingSummary":"新規リポジトリの状態を読み込み中です。","new.error":"新規リポジトリの状態を読み込めないため、このフィルターは利用できません。",
  "result.count":"{count}件のリポジトリ","result.filters":"探索フィルター{count}件","result.favorites":"お気に入り表示","result.hidden":"非表示{count}件","tooltip.language":"要約の言語",
  "repo.aria":"{name}リポジトリ","repo.favorite":"お気に入り","repo.favoriteAdd":"{name} をお気に入りに追加","repo.favoriteRemove":"{name} をお気に入りから削除","repo.forks":"fork","repo.totalStars":"総スター数",
  "classification.form":"形態","classification.field":"分野・技術","classification.ai":"AI関連","history.loading":"📈 スター履歴を読み込み中…","history.failed":"📈 スター履歴を読み込めませんでした","history.title":"スター履歴","history.explanation":"このサイトが直接観測したスター総数（30分間隔）· 破線は GitHub Trending の期間集計から逆算したアンカー","history.observedSince":"観測開始","history.ariaTrend":"スター推移","history.waiting":"観測開始待ち","history.singleObservation":"観測1回"
};

const MESSAGES=Object.freeze({en:Object.freeze(EN),ko:Object.freeze(KO),"zh-CN":Object.freeze(ZH),es:Object.freeze(ES),ja:Object.freeze(JA)});

function normalizeLocale(value){
  const input=String(value||"").trim().replaceAll("_","-").toLowerCase();
  if(!input)return null;
  if(input==="zh"||input.startsWith("zh-"))return "zh-CN";
  return SUPPORTED_LOCALES.find(locale=>input===locale.toLowerCase()||input.startsWith(`${locale.toLowerCase()}-`))||null;
}

function resolveLocale(storage,navigatorLike){
  try{const saved=normalizeLocale(storage?.getItem?.(STORAGE_KEY));if(saved)return saved}catch{}
  const candidates=Array.isArray(navigatorLike?.languages)?navigatorLike.languages:[navigatorLike?.language];
  for(const candidate of candidates){const locale=normalizeLocale(candidate);if(locale)return locale}
  return "en";
}

function interpolate(value,parameters={}){
  return String(value).replace(/\{([A-Za-z0-9_]+)\}/g,(_,key)=>Object.hasOwn(parameters,key)?String(parameters[key]):`{${key}}`);
}

function create({document:documentLike=root.document,storage=root.localStorage,navigator:navigatorLike=root.navigator}={}){
  let locale=resolveLocale(storage,navigatorLike);
  const translate=(key,parameters)=>interpolate(MESSAGES[locale][key]??MESSAGES.en[key]??key,parameters);
  function apply(nextLocale=locale,{persist=false,notify=false}={}){
    locale=normalizeLocale(nextLocale)||"en";
    if(persist){try{storage?.setItem?.(STORAGE_KEY,locale)}catch{}}
    if(documentLike){
      documentLike.documentElement?.setAttribute?.("lang",locale);
      if("title" in documentLike)documentLike.title=translate("document.title");
      documentLike.querySelectorAll?.("[data-i18n]").forEach(node=>{node.textContent=translate(node.dataset.i18n)});
      for(const attribute of ["aria-label","title","placeholder"]){
        const dataName=`i18n${attribute.split("-").map(part=>part[0].toUpperCase()+part.slice(1)).join("")}`;
        documentLike.querySelectorAll?.(`[data-i18n-${attribute}]`).forEach(node=>node.setAttribute(attribute,translate(node.dataset[dataName])));
      }
      const selector=documentLike.getElementById?.("siteLocale");if(selector)selector.value=locale;
      if(notify&&typeof root.CustomEvent==="function")documentLike.dispatchEvent?.(new root.CustomEvent("site-locale-change",{detail:{locale}}));
    }
    return locale;
  }
  apply(locale);
  return Object.freeze({get locale(){return locale},t:translate,setLocale(nextLocale){return apply(nextLocale,{persist:true,notify:true})},apply});
}

root.SiteI18n=Object.freeze({STORAGE_KEY,SUPPORTED_LOCALES,MESSAGES,normalizeLocale,resolveLocale,create});
})(globalThis);
