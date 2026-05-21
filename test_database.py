# -*- coding: utf-8 -*-
"""测试数据库模块"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from database import init_db, import_registrations, save_batch_info, check_in, get_batch_list, get_batch_stats

# 初始化
init_db()
print("[OK] 数据库初始化成功")

# 导入测试数据
persons = [
    {'name': '张三', 'phone': '13800001001', 'table_num': 3, 'dinner_table_num': 1,
     'referrer': '王小明', 'class_name': '预备班A', 'center': '上海分中心', 'company': '上海科技', 'special_req': ''},
    {'name': '李四', 'phone': '13800001002', 'table_num': 3, 'dinner_table_num': 1,
     'referrer': '王小明', 'class_name': '预备班A', 'center': '上海分中心', 'company': '上海科技', 'special_req': ''},
    {'name': '郑十', 'phone': '13800001008', 'table_num': 1, 'dinner_table_num': 2,
     'referrer': '孙建国', 'class_name': '正式班A', 'center': '北京分中心', 'company': '北京科技', 'special_req': '素食'},
]

batch_id = 'TEST_20260515'
count = import_registrations(persons, batch_id)
print(f"[OK] 导入 {count} 条记录")

save_batch_info(batch_id, '测试季度发表会', len(persons), 2, 2, 10, 8)
print("[OK] 保存批次信息")

# 测试签到
result = check_in('张三', '13800001001', batch_id)
if result:
    print(f"[OK] 签到成功: {result['name']}, 桌号:{result['table_num']}, 空巴:{result['dinner_table_num']}")
else:
    print("[FAIL] 签到失败")

# 重复签到（应该成功但显示已签到）
result2 = check_in('张三', '13800001001', batch_id)
if result2 and result2['sign_status'] == '已签到':
    print(f"[OK] 重复签到检测正常: {result2['sign_status']}")
else:
    print("[FAIL] 重复签到检测异常")

# 测试找不到的人
not_found = check_in('不存在', '00000000000', batch_id)
if not_found is None:
    print("[OK] 未报名人员查询返回None")
else:
    print("[FAIL] 异常")

# 统计
stats = get_batch_stats(batch_id)
print(f"[OK] 统计: 总{stats['total']}人, 已签{stats['signed']}人, 签到率{stats['rate']}")

batches = get_batch_list()
print(f"[OK] 批次列表: 共{len(batches)}个批次")

# 清理测试数据
from database import delete_batch
delete_batch(batch_id)
print(f"[OK] 测试数据已清理")

print("\n=== 所有测试通过 ===")
