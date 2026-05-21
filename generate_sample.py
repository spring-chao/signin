# -*- coding: utf-8 -*-
"""生成示例 Excel 报名名单"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pandas as pd

data = {
    '姓名': ['张三', '李四', '王五', '赵六', '陈七', '周八', '吴九', '郑十'],
    '手机号': ['13800001001', '13800001002', '13800001003', '13800001004',
               '13800001005', '13800001006', '13800001007', '13800001008'],
    '推荐人': ['王小明', '王小明', '王小明', '王小明', '刘大伟', '刘大伟', '刘大伟', '孙建国'],
    '班级': ['预备班A', '预备班A', '预备班A', '预备班A', '预备班B', '预备班B', '预备班B', '正式班A'],
    '分中心': ['上海分中心', '上海分中心', '上海分中心', '上海分中心',
               '上海分中心', '上海分中心', '上海分中心', '北京分中心'],
    '公司': ['上海科技', '上海科技', '上海信息', '上海信息',
             '上海咨询', '上海咨询', '上海咨询', '北京科技'],
    '特殊要求': ['', '', '', '', '', '', '', '素食']
}

df = pd.DataFrame(data)
filepath = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sample_data.xlsx')
df.to_excel(filepath, index=False)
print(f'[OK] 已生成示例文件: {filepath}')
print(f'     共 {len(df)} 条数据')
print(f'     列名: {list(df.columns)}')
