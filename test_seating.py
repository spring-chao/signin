# -*- coding: utf-8 -*-
"""测试分桌算法"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from seating_algo import Person, assign_tables, assign_dinner_tables, generate_summary, export_to_dataframe

# 创建测试数据 - 模拟一个实际的季度发表会报名名单
test_data = [
    # (姓名, 手机号, 推荐人, 班级, 分中心, 公司, 特殊要求)
    ("张三", "13800001001", "王小明", "预备班A", "上海分中心", "上海科技有限公司", ""),
    ("李四", "13800001002", "王小明", "预备班A", "上海分中心", "上海科技有限公司", ""),
    ("王五", "13800001003", "王小明", "预备班A", "上海分中心", "上海信息科技", ""),
    ("赵六", "13800001004", "王小明", "预备班A", "上海分中心", "上海信息科技", ""),

    ("陈七", "13800001005", "刘大伟", "预备班B", "上海分中心", "上海咨询公司", ""),
    ("周八", "13800001006", "刘大伟", "预备班B", "上海分中心", "上海咨询公司", ""),
    ("吴九", "13800001007", "刘大伟", "预备班B", "上海分中心", "上海咨询公司", ""),

    ("郑十", "13800001008", "孙建国", "正式班A", "北京分中心", "北京科技有限公司", "素食"),
    ("冯十一", "13800001009", "孙建国", "正式班A", "北京分中心", "北京科技有限公司", ""),
    ("褚十二", "13800001010", "孙建国", "正式班A", "北京分中心", "北京科技有限公司", ""),

    ("卫十三", "13800001011", "孙建国", "正式班A", "北京分中心", "北京科技集团", ""),
    ("蒋十四", "13800001012", "孙建国", "正式班A", "北京分中心", "北京科技集团", ""),

    ("沈十五", "13800001013", "", "预备班C", "广州分中心", "广州贸易公司", ""),
    ("韩十六", "13800001014", "", "预备班C", "广州分中心", "广州贸易公司", ""),
    ("杨十七", "13800001015", "", "预备班C", "广州分中心", "广州贸易公司", ""),
    ("朱十八", "13800001016", "", "预备班C", "广州分中心", "广州贸易公司", ""),

    ("秦十九", "13800001017", "", "", "深圳分中心", "深圳创新科技", ""),
    ("许二十", "13800001018", "", "", "深圳分中心", "深圳创新科技", ""),
    ("何二十一", "13800001019", "", "", "深圳分中心", "深圳创新科技", ""),

    ("吕二十二", "13800001020", "", "", "成都分中心", "成都餐饮管理", "不吃辣"),
    ("施二十三", "13800001021", "", "", "成都分中心", "成都餐饮管理", ""),
]

# 构建 Person 对象
persons = []
for i, (name, phone, referrer, cls, center, company, special) in enumerate(test_data):
    p = Person(name=name, phone=phone, referrer=referrer,
               class_name=cls, center=center, company=company,
               special_req=special, raw_index=i)
    persons.append(p)

print(f"总人数: {len(persons)}")
print()

# 执行分桌
assign_tables(persons, capacity=6)  # 用6人一桌方便测试
assign_dinner_tables(persons, capacity=6)

# 输出结果
summary = generate_summary(persons)
print(f"正座桌数: {summary['total_tables']}")
print(f"空巴桌数: {summary['total_dinner_tables']}")
print()

# 按桌号分组显示
tables = {}
for p in persons:
    tables.setdefault(p.table_num, []).append(p)

for tn in sorted(tables.keys()):
    people = tables[tn]
    print(f"\n{'='*50}")
    print(f"[正座] 桌号 {tn} - {len(people)}人")
    print(f"{'='*50}")
    for p in people:
        print(f"  {p.name:6s} | 推荐人:{p.referrer:6s} | 班级:{p.class_name:8s} | 分中心:{p.center:6s} | 公司:{p.company:10s} | 空巴:{p.dinner_table_num}号桌")

# 检查分桌规则
print(f"\n\n{'='*60}")
print("规则验证：")
print(f"{'='*60}")

for tn in sorted(tables.keys()):
    people = tables[tn]
    referrers = set(p.referrer for p in people if p.referrer)
    if len(referrers) == 1:
        print(f"  [OK] 桌{tn}: 推荐人相同（{list(referrers)[0]}）")
    elif len(referrers) > 1:
        print(f"  [i] 桌{tn}: 混合推荐人 {referrers}")

# 输出完整表格
print(f"\n\n完整数据表：")
df = export_to_dataframe(persons)
print(df.to_string(index=False))
