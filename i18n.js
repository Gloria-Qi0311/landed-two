const ResumeFillerI18n = (() => {
  const STORAGE_KEY = 'uiLang';
  let currentLang = 'zh';
  let initPromise = null;

  const messages = {
    zh: {
      'common.lang_toggle': 'EN',
      'common.add_item': '+ 添加一条',
      'common.move_up': '上移',
      'common.move_down': '下移',
      'common.delete': '删除',
      'common.confirm_delete': '确认删除这一条？',
      'common.priority_note': '（填表时优先使用）',
      'common.empty_list': '暂无内容。点右上“添加一条”新增。',
      'common.card_default_education': '教育经历',
      'common.card_default_experience': '工作经历',
      'common.card_default_internship': '实习经历',
      'common.card_default_project': '项目',
      'common.current_job': '目前就职',
      'common.other': '其他',

      'popup.document_title': 'ApplyMint',
      'popup.hero_eyebrow': '一次导入 · 可视化编辑 · 一键填表',
      'popup.hero_desc': '把简历交给 AI 转成 JSON，再用同一份资料快速填写招聘表单。',
      'popup.hero_note': '先看简介，再依次完成复制提示词、导入 JSON，最后就能自动填写。',
      'popup.hero_card_title': '三步搞定求职表单',
      'popup.intro_step1': '把简历 PDF 和我们提供的 AI 提示词一起发给 ChatGPT / Claude / Gemini 等工具，让它返回 JSON 格式',
      'popup.intro_step2': '把返回的 JSON 粘贴导入插件',
      'popup.intro_step3': '打开求职表单，一键自动填写',
      'popup.intro_cta': '进入第一步',
      'popup.step1.badge': 'STEP 1',
      'popup.step1.title': '复制 AI 提示词',
      'popup.step1.body': '把提示词和简历原文一起发给 ChatGPT / Claude / Gemini，让它只返回 JSON。',
      'popup.step1.copy_prompt': '复制提示词',
      'popup.step1.copy_schema': '复制模板',
      'popup.step1.next': '下一步',
      'popup.step1.back': '返回简介',
      'popup.step2.badge': 'STEP 2',
      'popup.step2.title': '粘贴 JSON 导入',
      'popup.step2.body': '把 AI 返回的 JSON 粘贴进来，缺失字段会自动补空。',
      'popup.step2.hint': '支持完整 JSON；缺失字段会自动补空。',
      'popup.step2.import': '导入简历',
      'popup.step2.back': '上一步',
      'popup.json_placeholder': '{\n  "version": 1,\n  "basic": { "name": "..." },\n  ...\n}',
      'popup.loaded_badge': '已加载简历',
      'popup.fill_button': '开始自动填写',
      'popup.fill_loading': '填写中…',
      'popup.manual_title': '需手动填写的字段',
      'popup.open_editor': '打开完整编辑器',
      'popup.reimport': '重新导入 JSON',
      'popup.no_name': '(未填姓名)',
      'popup.copy_ok': '已复制',
      'popup.import_empty': '请先粘贴 JSON 内容',
      'popup.import_error': 'JSON 格式错误：{message}',
      'popup.import_ok': '已导入，正在打开编辑器预览…',
      'popup.reimport_confirm': '这会用新粘贴的 JSON 覆盖当前简历。如果想保留这份、再加一份，请取消并改用「导入新简历」。继续？',
      'popup.status_no_resume': '请先导入简历 JSON',
      'popup.status_connect_error': '无法连接到页面，请刷新后重试',
      'popup.status_filled': '已自动填写 {count} 个字段',
      'popup.status_no_match': '未找到可匹配的字段',
      'popup.manual_value': '参考值：{value}',
      'popup.ai_disclaimer': 'ApplyMint是AI工具，自动填写内容可能存在误差，请核对后提交。',
      'popup.unmatched_placeholder': '输入字段值',
      'popup.unmatched_save': '保存到简历',
      'popup.unmatched_saved': '已保存 ✓',
      'popup.unmatched_skip': '跳过',
      'popup.unmatched_map_label': '永久映射到：',
      'popup.unmatched_map_choose': '选择简历字段...',
      'popup.profile_active': '使用简历',
      'popup.import_new': '导入新简历',
      'options.import_modal_ok_new': '导入为新简历',
      'popup.section.basic': '基本信息',
      'popup.section.intent': '求职意向',
      'popup.section.education': '教育',
      'popup.section.experience': '工作经历',
      'popup.section.internship': '实习经历',
      'popup.section.projects': '项目',
      'popup.section.skills': '技能',
      'popup.section.languages': '语言',
      'popup.section.summary': '自我介绍',
      'popup.section.other': '其他',
      'popup.ai_takeover_title': '让 AI 接管这些字段',
      'popup.ai_takeover_sub': '把未匹配的标签 + 你的简历发给 LLM，让它建议填写值',
      'popup.ai_takeover_btn': 'AI 接管',
      'popup.ai_takeover_running': 'AI 处理中...',
      'popup.ai_takeover_done': 'AI 已填 {count} 个字段',
      'popup.ai_takeover_empty': 'AI 没找到额外可填的字段',

      'options.document_title': 'ApplyMint · 编辑简历',
      'options.hero_title': '编辑你的简历资料',
      'options.hero_desc': '把一份简历整理成结构化资料，后面填表时就能一直复用。',
      'options.hint_html': '多段经历按时间倒序排列（<b>最近的放第一条</b>），填表时会优先使用第一条。字段留空没关系，填表时会自动跳过。',
      'options.btn_import': '导入 JSON',
      'options.btn_export': '导出 JSON',
      'options.btn_save': '保存',
      'options.saved': '已保存',
      'options.section.basic_title': '基本信息',
      'options.section.basic_sub': '姓名、联系方式、个人链接',
      'options.section.intent_title': '求职意向',
      'options.section.intent_sub': '应聘岗位、薪资、到岗时间',
      'options.section.education_title': '教育经历',
      'options.section.education_sub': '按时间倒序，最近的学历放第一条',
      'options.section.experience_title': '工作经历',
      'options.section.experience_sub': '按时间倒序，最近的工作放第一条',
      'options.section.internship_title': '实习经历',
      'options.section.internship_sub': '按时间倒序，最近的实习放第一条',
      'options.section.projects_title': '项目经验',
      'options.section.projects_sub': '可选；按时间倒序',
      'options.section.skills_title': '技能',
      'options.section.skills_sub': '按回车或逗号分隔添加',
      'options.section.languages_title': '语言',
      'options.section.languages_sub': '例如：英语 - 流利 / 日语 - N2',
      'options.section.summary_title': '自我介绍',
      'options.section.summary_sub': '会用于匹配 summary / about 这类字段',
      'options.section.custom_title': '自定义字段',
      'options.section.custom_sub': '填表未匹配到的字段，手动保存后可复用',
      'options.custom_empty': '暂无。使用自动填写遇到未匹配字段时，手动填值并保存后会出现在这里。',
      'options.custom_sub_label': '自定义',
      'options.section.ai_title': 'AI 设置（可选）',
      'options.section.ai_sub': '规则匹配失败时让 LLM 兜底，使用你自己的 API key',
      'options.ai.privacy_warning': '⚠️ 启用后，未匹配字段的标签 + 你的简历会被发送到所选 LLM 服务（你自己的 key）。仅在你信任该提供商时启用。API key 在本地 chrome.storage 用 base64 转码存储——这只能挡偶尔的肉眼浏览，不是加密。',
      'options.ai.enable_label': '启用 AI 兜底',
      'options.ai.enable_hint': '未启用时所有 AI 功能都关闭，简历不会被发送',
      'options.ai.provider_label': 'LLM 提供商',
      'options.ai.model_label': '模型（可选）',
      'options.ai.model_placeholder': '留空使用默认',
      'options.ai.endpoint_label': 'Endpoint（可选）',
      'options.ai.endpoint_placeholder': '留空使用提供商默认',
      'options.ai.api_key_label': 'API Key',
      'options.ai.api_key_placeholder': 'sk-...',
      'options.ai.show_key': '显示',
      'options.ai.hide_key': '隐藏',
      'options.ai.test_btn': '测试 Key',
      'options.ai.save_btn': '保存 AI 设置',
      'options.ai.testing': '正在测试...',
      'options.ai.test_ok': '✓ Key 有效',
      'options.ai.test_unauth': '✗ Key 无效或被拒绝（401/403）',
      'options.ai.test_failed': '✗ 请求失败：HTTP {status}',
      'options.ai.test_network': '✗ 网络错误：{message}',
      'options.ai.test_invalid': '✗ 配置不完整：{reason}',
      'options.ai.saved': '✓ AI 设置已保存',
      'options.skills_placeholder': '输入技能后回车，例如 React',
      'options.languages_placeholder': '输入语言后回车，例如 英语 - 流利',
      'options.summary_placeholder': '3 年前端开发经验，熟悉 React / Vue，专注性能优化...',
      'options.toast_saved': '简历已保存',
      'options.toast_exported': '已复制 JSON 到剪贴板',
      'options.toast_imported': '已导入到编辑器，记得点保存',
      'options.import_modal_title': '从 JSON 导入',
      'options.import_modal_body': '这会 <b>覆盖</b> 当前编辑器里的所有内容。如果只想备份，请先点“导出 JSON”。',
      'options.import_modal_cancel': '取消',
      'options.import_modal_ok': '导入并覆盖',
      'options.import_modal_placeholder': '{\n  "version": 1,\n  "basic": { "name": "..." },\n  ...\n}',
      'options.import_empty': '请粘贴 JSON',
      'options.import_error': 'JSON 解析失败：{message}',

      'options.basic.name_label': '姓名（全名）',
      'options.basic.name_placeholder': '张三',
      'options.basic.first_name_label': '名 First Name',
      'options.basic.first_name_placeholder': '三',
      'options.basic.last_name_label': '姓 Last Name',
      'options.basic.last_name_placeholder': '张',
      'options.basic.email_label': '邮箱',
      'options.basic.email_placeholder': 'zhangsan@gmail.com',
      'options.basic.phone_label': '手机',
      'options.basic.phone_placeholder': '138-0000-0000',
      'options.basic.wechat_label': '微信',
      'options.basic.wechat_placeholder': 'wxid_xxx',
      'options.basic.location_label': '所在城市',
      'options.basic.location_placeholder': '上海',
      'options.basic.linkedin_label': 'LinkedIn',
      'options.basic.linkedin_placeholder': 'linkedin.com/in/xxx',
      'options.basic.github_label': 'GitHub',
      'options.basic.github_placeholder': 'github.com/xxx',
      'options.basic.portfolio_label': '个人网站',
      'options.basic.portfolio_placeholder': 'https://xxx.com',

      'options.intent.position_label': '应聘职位',
      'options.intent.position_placeholder': '前端工程师',
      'options.intent.salary_label': '期望薪资',
      'options.intent.salary_placeholder': '25k-35k / 面议',
      'options.intent.available_label': '最早到岗',
      'options.intent.available_placeholder': '2 周内 / 随时',
      'options.intent.years_label': '工作年限',
      'options.intent.years_placeholder': '3 年',

      'options.education.school_label': '学校',
      'options.education.school_placeholder': '复旦大学',
      'options.education.location_label': '学校所在地',
      'options.education.location_placeholder': '上海',
      'options.education.degree_label': '学位',
      'options.education.degree_placeholder': '本科 / 硕士',
      'options.education.major_label': '专业',
      'options.education.major_placeholder': '计算机科学',
      'options.education.gpa_label': 'GPA',
      'options.education.gpa_placeholder': '3.8 / 4.0',
      'options.education.start_label': '开始时间',
      'options.education.start_placeholder': 'YYYY-MM',
      'options.education.end_label': '结束时间',
      'options.education.end_placeholder': 'YYYY-MM（至今留空）',
      'options.education.desc_label': '补充说明（课程、奖项等）',

      'options.experience.company_label': '公司',
      'options.experience.company_placeholder': '某科技公司',
      'options.experience.title_label': '职位',
      'options.experience.title_placeholder': '高级前端工程师',
      'options.experience.location_label': '工作地点',
      'options.experience.location_placeholder': '上海',
      'options.experience.start_label': '开始时间',
      'options.experience.start_placeholder': 'YYYY-MM',
      'options.experience.end_label': '结束时间',
      'options.experience.end_placeholder': 'YYYY-MM（至今留空）',
      'options.experience.desc_label': '工作描述',

      'options.internship.company_label': '公司名称',
      'options.internship.company_placeholder': '字节跳动',
      'options.internship.title_label': '实习职位',
      'options.internship.title_placeholder': '产品运营实习生',
      'options.internship.location_label': '工作地点',
      'options.internship.location_placeholder': '北京',
      'options.internship.start_label': '开始时间',
      'options.internship.start_placeholder': 'YYYY-MM',
      'options.internship.end_label': '结束时间',
      'options.internship.end_placeholder': 'YYYY-MM（至今留空）',
      'options.internship.desc_label': '实习描述',

      'options.projects.name_label': '项目名称',
      'options.projects.name_placeholder': 'ApplyMint',
      'options.projects.role_label': '角色',
      'options.projects.role_placeholder': '主程 / 负责人',
      'options.projects.link_label': '链接',
      'options.projects.link_placeholder': 'https://...',
      'options.projects.start_label': '开始时间',
      'options.projects.start_placeholder': 'YYYY-MM',
      'options.projects.end_label': '结束时间',
      'options.projects.end_placeholder': 'YYYY-MM（至今留空）',
      'options.projects.desc_label': '项目描述',

      'validation.required': '必填',
      'validation.email_format': '邮箱格式不正确',
      'validation.phone_format': '手机号格式不正确',
      'validation.url_format': '链接格式不正确',
      'validation.banner_title': '已保存。还有 {count} 个字段格式有问题需要修复：',

      'options.profile_name_label': '简历名称',
      'options.profile_duplicate': '复制为新',
      'options.profile_delete': '删除此简历',
      'options.profile_delete_confirm': '删除「{name}」？此操作不可撤销。',
      'options.profile_duplicated': '已复制为新简历',
      'options.profile_deleted': '已删除',
      'options.profile_renamed': '已重命名',
      'options.import_as_new': '作为新简历导入（保留当前这份）'
    },
    en: {
      'common.lang_toggle': '中文',
      'common.add_item': '+ Add item',
      'common.move_up': 'Up',
      'common.move_down': 'Down',
      'common.delete': 'Delete',
      'common.confirm_delete': 'Delete this entry?',
      'common.priority_note': '(used first when autofilling)',
      'common.empty_list': 'Nothing here yet. Click “Add item” in the top-right.',
      'common.card_default_education': 'Education',
      'common.card_default_experience': 'Experience',
      'common.card_default_internship': 'Internship',
      'common.card_default_project': 'Project',
      'common.current_job': 'Current role',
      'common.other': 'Other',

      'popup.document_title': 'ApplyMint',
      'popup.hero_eyebrow': 'One import · Visual editor · One-click autofill',
      'popup.hero_desc': 'Turn your resume into JSON with AI, then reuse the same profile across job forms.',
      'popup.hero_note': 'Start with the intro, move through prompt copy and JSON import, then autofill the page.',
      'popup.hero_card_title': 'Your resume, filled in 3 steps',
      'popup.intro_step1': 'Send your resume PDF together with our AI prompt to ChatGPT, Claude, Gemini, or any AI tool — ask it to return JSON format',
      'popup.intro_step2': 'Paste the returned JSON into the extension',
      'popup.intro_step3': 'Open a job application form and autofill with one click',
      'popup.intro_cta': 'Start step one',
      'popup.step1.badge': 'STEP 1',
      'popup.step1.title': 'Copy the AI prompt',
      'popup.step1.body': 'Send the prompt plus your resume text to ChatGPT, Claude, or Gemini, and ask for JSON only.',
      'popup.step1.copy_prompt': 'Copy prompt',
      'popup.step1.copy_schema': 'Copy schema',
      'popup.step1.next': 'Next',
      'popup.step1.back': 'Back to intro',
      'popup.step2.badge': 'STEP 2',
      'popup.step2.title': 'Paste JSON to import',
      'popup.step2.body': 'Paste the JSON response here. Missing fields will be filled with empty defaults.',
      'popup.step2.hint': 'Full JSON is supported. Missing fields will be filled automatically.',
      'popup.step2.import': 'Import resume',
      'popup.step2.back': 'Previous',
      'popup.json_placeholder': '{\n  "version": 1,\n  "basic": { "name": "..." },\n  ...\n}',
      'popup.loaded_badge': 'Resume loaded',
      'popup.fill_button': 'Start autofill',
      'popup.fill_loading': 'Filling…',
      'popup.manual_title': 'Fields to fill manually',
      'popup.open_editor': 'Open full editor',
      'popup.reimport': 'Import new JSON',
      'popup.no_name': '(No name yet)',
      'popup.copy_ok': 'Copied',
      'popup.import_empty': 'Paste JSON first',
      'popup.import_error': 'Invalid JSON: {message}',
      'popup.import_ok': 'Imported. Opening the preview…',
      'popup.reimport_confirm': 'The pasted JSON will overwrite your current resume. To keep this one and add another, cancel and use "Import new resume" instead. Continue?',
      'popup.status_no_resume': 'Import a resume JSON first',
      'popup.status_connect_error': 'Could not connect to the page. Refresh and try again.',
      'popup.status_filled': 'Autofilled {count} fields',
      'popup.status_no_match': 'No matching fields were found',
      'popup.manual_value': 'Suggested value: {value}',
      'popup.ai_disclaimer': 'ApplyMint is AI and can make mistakes. Please double-check autofilled information.',
      'popup.unmatched_placeholder': 'Enter field value',
      'popup.unmatched_save': 'Save to resume',
      'popup.unmatched_saved': 'Saved ✓',
      'popup.unmatched_skip': 'Skip',
      'popup.unmatched_map_label': 'Permanently map to:',
      'popup.unmatched_map_choose': 'Choose resume field...',
      'popup.profile_active': 'Active resume',
      'popup.import_new': 'Import new resume',
      'options.import_modal_ok_new': 'Import as new resume',
      'popup.section.basic': 'Basic Info',
      'popup.section.intent': 'Job Target',
      'popup.section.education': 'Education',
      'popup.section.experience': 'Experience',
      'popup.section.internship': 'Internship',
      'popup.section.projects': 'Projects',
      'popup.section.skills': 'Skills',
      'popup.section.languages': 'Languages',
      'popup.section.summary': 'Summary',
      'popup.section.other': 'Other',
      'popup.ai_takeover_title': 'Let AI take over these fields',
      'popup.ai_takeover_sub': 'Send the unmatched labels + your resume to the configured LLM',
      'popup.ai_takeover_btn': 'AI takeover',
      'popup.ai_takeover_running': 'AI working...',
      'popup.ai_takeover_done': 'AI filled {count} fields',
      'popup.ai_takeover_empty': 'AI did not propose any new fills',

      'options.document_title': 'ApplyMint · Edit Resume',
      'options.hero_title': 'Edit your resume profile',
      'options.hero_desc': 'Keep one structured resume profile here, then reuse it every time you autofill a job form.',
      'options.hint_html': 'Sort entries in reverse chronological order, with the <b>most recent first</b>. Autofill will prefer the first item. Empty fields are fine and will simply be skipped.',
      'options.btn_import': 'Import JSON',
      'options.btn_export': 'Export JSON',
      'options.btn_save': 'Save',
      'options.saved': 'Saved',
      'options.section.basic_title': 'Basics',
      'options.section.basic_sub': 'Name, contact details, and profile links',
      'options.section.intent_title': 'Job target',
      'options.section.intent_sub': 'Target role, salary, and availability',
      'options.section.education_title': 'Education',
      'options.section.education_sub': 'Reverse chronological order, newest first',
      'options.section.experience_title': 'Experience',
      'options.section.experience_sub': 'Reverse chronological order, newest first',
      'options.section.internship_title': 'Internship',
      'options.section.internship_sub': 'Reverse chronological order, newest first',
      'options.section.projects_title': 'Projects',
      'options.section.projects_sub': 'Optional, also newest first',
      'options.section.skills_title': 'Skills',
      'options.section.skills_sub': 'Press Enter or comma to add items',
      'options.section.languages_title': 'Languages',
      'options.section.languages_sub': 'Example: English - Fluent / Japanese - N2',
      'options.section.summary_title': 'Summary',
      'options.section.summary_sub': 'Used for summary / about style fields',
      'options.section.custom_title': 'Custom Fields',
      'options.section.custom_sub': 'Fields not auto-matched; saved manually for reuse',
      'options.custom_empty': 'None yet. When autofilling, save unmatched fields here to reuse them later.',
      'options.custom_sub_label': 'Custom',
      'options.section.ai_title': 'AI Settings (optional)',
      'options.section.ai_sub': 'Optional LLM fallback when rule matching fails — bring your own API key',
      'options.ai.privacy_warning': '⚠️ When enabled, unmatched field labels + your resume are sent to the selected LLM provider using your own key. Only enable if you trust that provider. The API key is stored locally in chrome.storage with base64 obfuscation — that prevents casual eyeballing, not real encryption.',
      'options.ai.enable_label': 'Enable AI fallback',
      'options.ai.enable_hint': 'When off, all AI features are disabled and your resume is never sent',
      'options.ai.provider_label': 'LLM Provider',
      'options.ai.model_label': 'Model (optional)',
      'options.ai.model_placeholder': 'Leave blank for provider default',
      'options.ai.endpoint_label': 'Endpoint (optional)',
      'options.ai.endpoint_placeholder': 'Leave blank for provider default',
      'options.ai.api_key_label': 'API Key',
      'options.ai.api_key_placeholder': 'sk-...',
      'options.ai.show_key': 'Show',
      'options.ai.hide_key': 'Hide',
      'options.ai.test_btn': 'Test Key',
      'options.ai.save_btn': 'Save AI Settings',
      'options.ai.testing': 'Testing...',
      'options.ai.test_ok': '✓ Key is valid',
      'options.ai.test_unauth': '✗ Key invalid or rejected (401/403)',
      'options.ai.test_failed': '✗ Request failed: HTTP {status}',
      'options.ai.test_network': '✗ Network error: {message}',
      'options.ai.test_invalid': '✗ Configuration incomplete: {reason}',
      'options.ai.saved': '✓ AI settings saved',
      'options.skills_placeholder': 'Type a skill and press Enter, like React',
      'options.languages_placeholder': 'Type a language and press Enter, like English - Fluent',
      'options.summary_placeholder': '3 years of frontend experience, strong in React / Vue, focused on performance...',
      'options.toast_saved': 'Resume saved',
      'options.toast_exported': 'JSON copied to clipboard',
      'options.toast_imported': 'Imported into the editor. Don’t forget to save.',
      'options.import_modal_title': 'Import from JSON',
      'options.import_modal_body': 'This will <b>replace</b> everything currently in the editor. If you only want a backup, export JSON first.',
      'options.import_modal_cancel': 'Cancel',
      'options.import_modal_ok': 'Import and replace',
      'options.import_modal_placeholder': '{\n  "version": 1,\n  "basic": { "name": "..." },\n  ...\n}',
      'options.import_empty': 'Paste JSON first',
      'options.import_error': 'Could not parse JSON: {message}',

      'options.basic.name_label': 'Full name',
      'options.basic.name_placeholder': 'Jane Doe',
      'options.basic.first_name_label': 'First name',
      'options.basic.first_name_placeholder': 'Jane',
      'options.basic.last_name_label': 'Last name',
      'options.basic.last_name_placeholder': 'Doe',
      'options.basic.email_label': 'Email',
      'options.basic.email_placeholder': 'jane.doe@gmail.com',
      'options.basic.phone_label': 'Phone',
      'options.basic.phone_placeholder': '+1 555 000 0000',
      'options.basic.wechat_label': 'WeChat',
      'options.basic.wechat_placeholder': 'wxid_xxx',
      'options.basic.location_label': 'City',
      'options.basic.location_placeholder': 'Shanghai',
      'options.basic.linkedin_label': 'LinkedIn',
      'options.basic.linkedin_placeholder': 'linkedin.com/in/xxx',
      'options.basic.github_label': 'GitHub',
      'options.basic.github_placeholder': 'github.com/xxx',
      'options.basic.portfolio_label': 'Portfolio',
      'options.basic.portfolio_placeholder': 'https://xxx.com',

      'options.intent.position_label': 'Target role',
      'options.intent.position_placeholder': 'Frontend Engineer',
      'options.intent.salary_label': 'Target salary',
      'options.intent.salary_placeholder': '$120k-$150k / negotiable',
      'options.intent.available_label': 'Earliest start',
      'options.intent.available_placeholder': 'Within 2 weeks / Immediately',
      'options.intent.years_label': 'Years of experience',
      'options.intent.years_placeholder': '3 years',

      'options.education.school_label': 'School',
      'options.education.school_placeholder': 'Fudan University',
      'options.education.location_label': 'Location',
      'options.education.location_placeholder': 'Shanghai',
      'options.education.degree_label': 'Degree',
      'options.education.degree_placeholder': 'Bachelor / Master',
      'options.education.major_label': 'Major',
      'options.education.major_placeholder': 'Computer Science',
      'options.education.gpa_label': 'GPA',
      'options.education.gpa_placeholder': '3.8 / 4.0',
      'options.education.start_label': 'Start date',
      'options.education.start_placeholder': 'YYYY-MM',
      'options.education.end_label': 'End date',
      'options.education.end_placeholder': 'YYYY-MM (leave blank if ongoing)',
      'options.education.desc_label': 'Notes (courses, awards, etc.)',

      'options.experience.company_label': 'Company',
      'options.experience.company_placeholder': 'Example Tech',
      'options.experience.title_label': 'Title',
      'options.experience.title_placeholder': 'Senior Frontend Engineer',
      'options.experience.location_label': 'Location',
      'options.experience.location_placeholder': 'Shanghai',
      'options.experience.start_label': 'Start date',
      'options.experience.start_placeholder': 'YYYY-MM',
      'options.experience.end_label': 'End date',
      'options.experience.end_placeholder': 'YYYY-MM (leave blank if ongoing)',
      'options.experience.desc_label': 'Description',

      'options.internship.company_label': 'Company',
      'options.internship.company_placeholder': 'ByteDance',
      'options.internship.title_label': 'Intern title',
      'options.internship.title_placeholder': 'Product Operations Intern',
      'options.internship.location_label': 'Location',
      'options.internship.location_placeholder': 'Beijing',
      'options.internship.start_label': 'Start date',
      'options.internship.start_placeholder': 'YYYY-MM',
      'options.internship.end_label': 'End date',
      'options.internship.end_placeholder': 'YYYY-MM (leave blank if ongoing)',
      'options.internship.desc_label': 'Description',

      'options.projects.name_label': 'Project name',
      'options.projects.name_placeholder': 'ApplyMint',
      'options.projects.role_label': 'Role',
      'options.projects.role_placeholder': 'Lead / Owner',
      'options.projects.link_label': 'Link',
      'options.projects.link_placeholder': 'https://...',
      'options.projects.start_label': 'Start date',
      'options.projects.start_placeholder': 'YYYY-MM',
      'options.projects.end_label': 'End date',
      'options.projects.end_placeholder': 'YYYY-MM (leave blank if ongoing)',
      'options.projects.desc_label': 'Project description',

      'validation.required': 'Required',
      'validation.email_format': 'Invalid email format',
      'validation.phone_format': 'Invalid phone format',
      'validation.url_format': 'Invalid URL format',
      'validation.banner_title': 'Saved. {count} field(s) still need format fixes:',

      'options.profile_name_label': 'Resume name',
      'options.profile_duplicate': 'Duplicate as new',
      'options.profile_delete': 'Delete this resume',
      'options.profile_delete_confirm': "Delete '{name}'? This can't be undone.",
      'options.profile_duplicated': 'Duplicated as new resume',
      'options.profile_deleted': 'Deleted',
      'options.profile_renamed': 'Renamed',
      'options.import_as_new': "Save as a new resume (don't replace current)"
    }
  };

  function interpolate(template, params = {}) {
    return String(template).replace(/\{(\w+)\}/g, (_, key) => params[key] ?? '');
  }

  function getMessage(lang, key, params) {
    const fallback = messages.zh[key];
    const template = messages[lang]?.[key] ?? fallback ?? key;
    return interpolate(template, params);
  }

  function applyText(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = getMessage(currentLang, node.dataset.i18n);
    });

    root.querySelectorAll('[data-i18n-html]').forEach((node) => {
      // eslint-disable-next-line no-unsanitized/property -- value comes from developer-controlled i18n dictionary keyed by data-i18n-html
      node.innerHTML = getMessage(currentLang, node.dataset.i18nHtml);
    });

    root.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      node.setAttribute('placeholder', getMessage(currentLang, node.dataset.i18nPlaceholder));
    });

    root.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.setAttribute('title', getMessage(currentLang, node.dataset.i18nTitle));
    });

    root.querySelectorAll('[data-lang-toggle]').forEach((node) => {
      node.textContent = getMessage(currentLang, 'common.lang_toggle');
    });
  }

  function emitChange() {
    window.dispatchEvent(new CustomEvent('resumefiller:languagechange', {
      detail: { lang: currentLang }
    }));
  }

  function writeStorage(lang) {
    try {
      if (globalThis.chrome?.storage?.local) {
        chrome.storage.local.set({ [STORAGE_KEY]: lang });
        return;
      }
    } catch {
      // ignore
    }
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // ignore
    }
  }

  function readStorage() {
    return new Promise((resolve) => {
      try {
        if (globalThis.chrome?.storage?.local) {
          chrome.storage.local.get(STORAGE_KEY, (result) => {
            resolve(result?.[STORAGE_KEY] || 'zh');
          });
          return;
        }
      } catch {
        // ignore
      }

      try {
        resolve(localStorage.getItem(STORAGE_KEY) || 'zh');
      } catch {
        resolve('zh');
      }
    });
  }

  async function init() {
    if (!initPromise) {
      initPromise = readStorage().then((lang) => {
        currentLang = lang === 'en' ? 'en' : 'zh';
        applyText();
        emitChange();
        return currentLang;
      });
    }
    return initPromise;
  }

  function setLanguage(lang) {
    currentLang = lang === 'en' ? 'en' : 'zh';
    writeStorage(currentLang);
    applyText();
    emitChange();
  }

  function toggleLanguage() {
    setLanguage(currentLang === 'zh' ? 'en' : 'zh');
  }

  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-lang-toggle]');
    if (!toggle) return;
    toggleLanguage();
  });

  return {
    init,
    t(key, params) {
      return getMessage(currentLang, key, params);
    },
    getLanguage() {
      return currentLang;
    },
    setLanguage,
    toggleLanguage,
    applyText
  };
})();

window.ResumeFillerI18n = ResumeFillerI18n;
