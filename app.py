"""
活动签到系统 - Streamlit 应用
功能：
1. 管理员：上传报名名单 → 自动分桌 → 查看/导出分桌结果
2. 签到：扫码 → 输入姓名手机号 → 返回姓名、桌号、空巴桌号
"""
import streamlit as st
import pandas as pd
import os
import sys
import json
import uuid
from datetime import datetime
from io import BytesIO
import base64

try:
    import qrcode
    QR_AVAILABLE = True
except ImportError:
    QR_AVAILABLE = False

# 将当前目录加入路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from seating_algo import (
    parse_uploaded_file, assign_tables, assign_dinner_tables,
    generate_summary, export_to_dataframe, DEFAULT_TABLE_CAPACITY,
    DEFAULT_DINNER_CAPACITY
)
from database import (
    init_db, import_registrations, save_batch_info,
    check_in, get_batch_list, get_registrations_by_batch,
    get_batch_stats, delete_batch, query_person
)

# 初始化数据库
init_db()

# ========== 页面配置 ==========
st.set_page_config(
    page_title="活动签到与桌位管理系统",
    page_icon="✅",
    layout="wide",
    initial_sidebar_state="collapsed"
)

# 隐藏 Streamlit 默认样式
hide_streamlit_style = """
<style>
#MainMenu {visibility: hidden;}
footer {visibility: hidden;}
.stDeployButton {display:none;}
[data-testid="stToolbar"] {visibility: hidden;}
</style>
"""
st.markdown(hide_streamlit_style, unsafe_allow_html=True)

# ========== 状态管理 ==========
if 'page' not in st.session_state:
    st.session_state.page = 'checkin'  # 'checkin' 或 'admin'

# ========== 辅助函数 ==========
def generate_qr_code(url: str) -> str:
    """生成 QR 码并返回 base64 图片数据"""
    if not QR_AVAILABLE:
        return ""
    try:
        img = qrcode.make(url)
        buf = BytesIO()
        img.save(buf, format='PNG')
        buf.seek(0)
        img_base64 = base64.b64encode(buf.getvalue()).decode('utf-8')
        return img_base64
    except Exception:
        return ""

def run_seating(file_path, table_capacity, dinner_capacity, batch_name):
    """执行完整分桌流程"""
    with st.spinner("正在解析报名名单..."):
        persons = parse_uploaded_file(file_path)
    
    if not persons:
        st.error("未解析到有效报名数据，请检查文件格式！")
        return None
    
    st.success(f"✅ 共解析到 {len(persons)} 名参会人员")
    
    with st.spinner("正在进行白桌（正座）分桌..."):
        persons = assign_tables(persons, table_capacity)
    
    with st.spinner("正在进行空巴（晚宴）分桌..."):
        persons = assign_dinner_tables(persons, dinner_capacity)
    
    # 生成摘要
    summary = generate_summary(persons)
    
    # 保存到数据库
    batch_id = datetime.now().strftime('%Y%m%d%H%M%S') + '_' + str(uuid.uuid4())[:8]
    
    persons_list = []
    for p in persons:
        persons_list.append({
            'name': p.name,
            'phone': p.phone,
            'referrer': p.referrer,
            'class_name': p.class_name,
            'center': p.center,
            'company': p.company,
            'special_req': p.special_req,
            'table_num': p.table_num,
            'dinner_table_num': p.dinner_table_num,
        })
    
    import_registrations(persons_list, batch_id)
    save_batch_info(
        batch_id, batch_name,
        summary['total_people'],
        summary['total_tables'],
        summary['total_dinner_tables'],
        table_capacity, dinner_capacity
    )
    
    return {
        'batch_id': batch_id,
        'persons': persons,
        'summary': summary,
        'df': export_to_dataframe(persons)
    }


# ========== 侧边栏导航 ==========
with st.sidebar:
    st.title("📋 签到管理系统")
    st.divider()
    
    col1, col2 = st.columns(2)
    with col1:
        if st.button("✅ 签到", use_container_width=True,
                     type="primary" if st.session_state.page == 'checkin' else "secondary"):
            st.session_state.page = 'checkin'
            st.rerun()
    with col2:
        if st.button("⚙️ 管理", use_container_width=True,
                     type="primary" if st.session_state.page == 'admin' else "secondary"):
            st.session_state.page = 'admin'
            st.rerun()
    
    st.divider()
    
    # 显示当前活动批次
    batches = get_batch_list()
    if batches:
        st.caption(f"当前共有 {len(batches)} 个活动批次")
        selected_batch = st.selectbox(
            "选择活动批次",
            options=[b['batch_id'] for b in batches],
            format_func=lambda x: f"{next((b['batch_name'] for b in batches if b['batch_id']==x), x)[:20]} ({x[:8]}...)"
        )
        st.session_state.current_batch = selected_batch
        
        # 显示签到二维码（在管理页面时）
        if st.session_state.page == 'admin':
            st.divider()
            st.caption("签到二维码")
            # 获取当前 Streamlit 应用的 URL
            try:
                from streamlit.runtime.scriptrunner import get_script_run_ctx
                ctx = get_script_run_ctx()
                if ctx is not None:
                    app_url = f"https://{ctx.session_id}.streamlit.app"
                else:
                    app_url = "http://localhost:8501"
            except Exception:
                app_url = "http://localhost:8501"
            
            qr_base64 = generate_qr_code(app_url)
            if qr_base64:
                st.markdown(
                    f'<div style="text-align:center;"><img src="data:image/png;base64,{qr_base64}" width="200"/></div>',
                    unsafe_allow_html=True
                )
                st.caption(f"签到链接: {app_url}")
            else:
                st.info("请安装 qrcode 库以生成二维码: pip install qrcode")
    else:
        st.info("暂无活动批次，请在管理页面上传名单")


# ========== 签到页面 ==========
def render_checkin_page():
    """渲染签到页面"""
    st.title("✅ 活动签到")
    st.markdown("请填写您的报名信息完成签到")
    st.divider()
    
    # 获取当前批次
    batch_id = st.session_state.get('current_batch', '')
    
    if not batch_id:
        st.warning("⚠️ 当前没有可用的活动批次，请联系管理员设置。")
        return
    
    # 签到表单
    with st.container():
        col1, col2, col3 = st.columns([1, 2, 1])
        with col2:
            with st.form("checkin_form", clear_on_submit=True):
                name = st.text_input(
                    "👤 姓名",
                    placeholder="请输入您的真实姓名",
                    label_visibility="visible"
                )
                phone = st.text_input(
                    "📱 手机号",
                    placeholder="请输入报名时的手机号",
                    label_visibility="visible"
                )
                submitted = st.form_submit_button(
                    "✅ 签到",
                    type="primary",
                    use_container_width=True
                )
    
    # 处理签到
    if submitted:
        if not name or not phone:
            st.warning("⚠️ 请填写完整的姓名和手机号！")
        else:
            with st.spinner("正在查询签到信息..."):
                result = check_in(name.strip(), phone.strip(), batch_id)
            
            if result is None:
                st.error("❌ 未查询到您的报名信息！")
                st.info("请核对姓名和手机号是否填写正确，或联系工作人员协助。")
            else:
                # 签到成功！
                name_display = result['name']
                table_num = result['table_num']
                dinner_table = result['dinner_table_num']
                sign_status = result['sign_status']
                sign_time = result.get('sign_time', '')
                
                # 显示成功信息
                st.balloons()
                
                col1, col2, col3 = st.columns([1, 3, 1])
                with col2:
                    st.success("✅ **签到成功！**")
                    
                    # 用卡片展示签到信息
                    info_html = f"""
                    <div style="
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        border-radius: 16px;
                        padding: 24px;
                        color: white;
                        margin: 16px 0;
                        box-shadow: 0 4px 15px rgba(0,0,0,0.2);
                    ">
                        <h3 style="margin:0 0 16px 0; text-align:center; font-size:24px;">🎉 欢迎您！</h3>
                        <div style="text-align:center; font-size:20px; margin-bottom:16px;">
                            <strong>{name_display}</strong>
                        </div>
                        <hr style="border-color: rgba(255,255,255,0.3); margin: 12px 0;">
                        <table style="width:100%; font-size:18px; line-height:2;">
                    """
                    
                    if table_num:
                        info_html += f"""
                        <tr>
                            <td style="text-align:center;">🪑 <strong>桌号</strong></td>
                            <td style="text-align:center; font-size:28px; font-weight:bold;">{table_num} 号桌</td>
                        </tr>
                        """
                    
                    if dinner_table:
                        info_html += f"""
                        <tr>
                            <td style="text-align:center;">🍷 <strong>空巴桌号</strong></td>
                            <td style="text-align:center; font-size:28px; font-weight:bold;">{dinner_table} 号桌</td>
                        </tr>
                        """
                    
                    if sign_time:
                        time_str = sign_time.split('.')[0] if '.' in sign_time else sign_time
                        info_html += f"""
                        <tr>
                            <td style="text-align:center;">⏰ <strong>签到时间</strong></td>
                            <td style="text-align:center;">{time_str}</td>
                        </tr>
                        """
                    
                    info_html += """
                        </table>
                    </div>
                    """
                    
                    st.markdown(info_html, unsafe_allow_html=True)
                    
                    if sign_status == "已签到" and sign_time:
                        time_str = sign_time.split('.')[0] if '.' in sign_time else sign_time
                        st.info(f"📌 您已于 {time_str} 完成签到")
                    else:
                        st.success("祝您参会愉快！🎉")


# ========== 管理页面 ==========
def render_admin_page():
    """渲染管理页面"""
    st.title("⚙️ 活动管理")
    st.divider()
    
    tab1, tab2, tab3 = st.tabs(["📤 上传名单", "📊 分桌结果", "📈 签到统计"])
    
    # ======== Tab 1: 上传名单 ========
    with tab1:
        st.subheader("📤 上传报名名单 & 自动分桌")
        st.markdown("""
        **支持的格式：** Excel (.xlsx, .xls) 或 CSV (.csv)
        
        **需要包含的列（列名可灵活匹配）：**
        - `姓名`（必填）
        - `手机号`（必填，用于签到验证）
        - `推荐人`、`班级`、`分中心`、`公司`、`特殊要求`（选填，用于分桌算法）
        """)
        
        with st.expander("📋 查看示例数据格式", expanded=False):
            sample_data = {
                '姓名': ['张三', '李四', '王五'],
                '手机号': ['13800001111', '13800002222', '13800003333'],
                '推荐人': ['赵六', '赵六', '孙七'],
                '班级': ['预备班A', '预备班A', '预备班B'],
                '分中心': ['上海分中心', '上海分中心', '北京分中心'],
                '公司': ['甲公司', '甲公司', '乙公司'],
                '特殊要求': ['', '', '素食']
            }
            sample_df = pd.DataFrame(sample_data)
            st.dataframe(sample_df, use_container_width=True)
        
        st.divider()
        
        # 上传文件
        uploaded_file = st.file_uploader(
            "选择报名名单文件",
            type=['xlsx', 'xls', 'csv'],
            help="支持 Excel (.xlsx, .xls) 和 CSV (.csv) 格式"
        )
        
        if uploaded_file is not None:
            # 保存上传的文件
            temp_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'temp')
            os.makedirs(temp_dir, exist_ok=True)
            temp_path = os.path.join(temp_dir, uploaded_file.name)
            
            with open(temp_path, 'wb') as f:
                f.write(uploaded_file.getbuffer())
            
            # 读取预览
            try:
                if uploaded_file.name.endswith('.csv'):
                    preview_df = pd.read_csv(temp_path, dtype=str)
                else:
                    preview_df = pd.read_excel(temp_path, dtype=str)
                preview_df.columns = [c.strip() for c in preview_df.columns]
                
                st.success(f"✅ 文件上传成功，共 {len(preview_df)} 行数据")
                st.caption("数据预览（前10行）：")
                st.dataframe(preview_df.head(10), use_container_width=True)
                
            except Exception as e:
                st.error(f"文件解析失败：{str(e)}")
                return
            
            # 分桌参数设置
            st.divider()
            st.subheader("⚙️ 分桌参数设置")
            
            col1, col2 = st.columns(2)
            with col1:
                batch_name = st.text_input(
                    "活动名称（批次）",
                    value=f"季度发表会_{datetime.now().strftime('%Y%m%d')}",
                    help="用于标识本次活动的名称"
                )
            with col2:
                pass
            
            col1, col2 = st.columns(2)
            with col1:
                table_capacity = st.number_input(
                    "每桌人数（正座）",
                    min_value=4, max_value=20, value=DEFAULT_TABLE_CAPACITY,
                    help="白桌（正座会议）每桌安排的人数"
                )
            with col2:
                dinner_capacity = st.number_input(
                    "每桌人数（空巴/晚宴）",
                    min_value=4, max_value=20, value=DEFAULT_DINNER_CAPACITY,
                    help="空巴（晚宴）每桌安排的人数"
                )
            
            if st.button("🚀 开始自动分桌", type="primary", use_container_width=True):
                result = run_seating(temp_path, table_capacity, dinner_capacity, batch_name)
                
                if result:
                    st.session_state.last_result = result
                    st.balloons()
                    st.success(f"""
                    ✅ **分桌完成！**
                    - 总人数：{result['summary']['total_people']}
                    - 白桌（正座）：共 {result['summary']['total_tables']} 桌
                    - 空巴（晚宴）：共 {result['summary']['total_dinner_tables']} 桌
                    - 批次ID：{result['batch_id']}
                    """)
    
    # ======== Tab 2: 分桌结果 ========
    with tab2:
        st.subheader("📊 分桌结果查看")
        
        batches = get_batch_list()
        if not batches:
            st.info("暂无批次数据，请先在「上传名单」页签上传报名名单。")
        else:
            batch_options = {b['batch_id']: b for b in batches}
            selected_id = st.selectbox(
                "选择批次",
                options=list(batch_options.keys()),
                format_func=lambda x: f"{batch_options[x].get('batch_name', x)} ({batch_options[x]['total_people']}人)"
            )
            
            if selected_id:
                registrations = get_registrations_by_batch(selected_id)
                if registrations:
                    # 导出按钮
                    df_display = pd.DataFrame(registrations)
                    # 重命名列用于展示
                    col_map = {
                        'name': '姓名', 'phone': '手机号', 'referrer': '推荐人',
                        'class_name': '班级', 'center': '分中心', 'company': '公司',
                        'special_req': '特殊要求', 'table_num': '桌号',
                        'dinner_table_num': '空巴桌号', 'sign_status': '签到状态',
                        'sign_time': '签到时间'
                    }
                    df_display = df_display.rename(columns=col_map)
                    display_cols = [v for v in col_map.values() if v in df_display.columns]
                    df_display = df_display[display_cols]
                    
                    st.dataframe(df_display, use_container_width=True, height=400)
                    
                    # 导出为CSV
                    csv = df_display.to_csv(index=False, encoding='utf-8-sig').encode('utf-8-sig')
                    st.download_button(
                        label="📥 导出为 CSV",
                        data=csv,
                        file_name=f"分桌结果_{selected_id[:8]}.csv",
                        mime="text/csv",
                        use_container_width=True
                    )
                    
                    # 按桌号查看
                    st.divider()
                    st.subheader("📋 按桌号查看")
                    
                    # 正座桌号分布
                    tables_data = df_display[df_display['桌号'].notna() & (df_display['桌号'] != '')]
                    if not tables_data.empty:
                        table_groups = tables_data.groupby('桌号')
                        for table_num, group in sorted(table_groups):
                            with st.expander(f"🪑 正座 {int(table_num)} 号桌（{len(group)}人）"):
                                st.dataframe(
                                    group[['姓名', '班级', '分中心', '公司']].reset_index(drop=True),
                                    use_container_width=True
                                )
                    
                    # 空巴桌号分布
                    dinner_data = df_display[df_display['空巴桌号'].notna() & (df_display['空巴桌号'] != '')]
                    if not dinner_data.empty:
                        dinner_groups = dinner_data.groupby('空巴桌号')
                        for table_num, group in sorted(dinner_groups):
                            with st.expander(f"🍷 空巴 {int(table_num)} 号桌（{len(group)}人）"):
                                st.dataframe(
                                    group[['姓名', '班级', '分中心']].reset_index(drop=True),
                                    use_container_width=True
                                )
                else:
                    st.info("该批次暂无数据")
    
    # ======== Tab 3: 签到统计 ========
    with tab3:
        st.subheader("📈 签到统计")
        
        batches = get_batch_list()
        if not batches:
            st.info("暂无数据")
        else:
            for b in batches:
                stats = get_batch_stats(b['batch_id'])
                with st.container():
                    col1, col2, col3, col4 = st.columns(4)
                    with col1:
                        st.metric("总人数", stats['total'])
                    with col2:
                        st.metric("已签到", stats['signed'], delta_color="off")
                    with col3:
                        st.metric("未签到", stats['unsigned'])
                    with col4:
                        st.metric("签到率", stats['rate'])
                    
                    with st.expander(f"📌 {b.get('batch_name', b['batch_id'][:12])} - 查看详情"):
                        regs = get_registrations_by_batch(b['batch_id'])
                        if regs:
                            df_stats = pd.DataFrame(regs)
                            df_stats = df_stats.rename(columns={
                                'name': '姓名', 'phone': '手机号',
                                'table_num': '桌号', 'dinner_table_num': '空巴桌号',
                                'sign_status': '签到状态', 'sign_time': '签到时间'
                            })
                            show_cols = [c for c in ['姓名', '手机号', '桌号', '空巴桌号', '签到状态', '签到时间'] if c in df_stats.columns]
                            st.dataframe(df_stats[show_cols], use_container_width=True)
                    
                    st.divider()
            
            # 清理数据
            with st.expander("⚠️ 数据管理", expanded=False):
                st.warning("删除后数据不可恢复，请谨慎操作！")
                batch_to_delete = st.selectbox(
                    "选择要删除的批次",
                    options=[b['batch_id'] for b in batches],
                    format_func=lambda x: f"{next((b['batch_name'] for b in batches if b['batch_id']==x), x)}"
                )
                if st.button("🗑️ 删除所选批次", type="secondary"):
                    delete_batch(batch_to_delete)
                    st.success(f"已删除批次 {batch_to_delete[:12]}")
                    st.rerun()


# ========== 渲染页面 ==========
if st.session_state.page == 'checkin':
    render_checkin_page()
else:
    render_admin_page()

# ========== 页脚 ==========
st.divider()
st.caption("活动签到与桌位管理系统 v2.0 | 由 AtomCode 搭建")
