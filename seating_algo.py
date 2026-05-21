"""
桌位排序算法
规则优先级：
1. 推荐人相同 → 同一桌
2. 班级相同 → 同一桌
3. 分中心相同 → 同一桌
4. 特殊情况：同一公司 → 同一桌
5. 特殊要求 → 同一桌
"""

from collections import defaultdict
import pandas as pd
import json
from typing import List, Dict, Tuple, Optional


# 每桌默认人数
DEFAULT_TABLE_CAPACITY = 10
# 空巴每桌人数（通常比正座宽松）
DEFAULT_DINNER_CAPACITY = 8


class Person:
    """报名人员信息"""
    def __init__(self, name: str, phone: str, referrer: str = "",
                 class_name: str = "", center: str = "", company: str = "",
                 special_req: str = "", raw_index: int = 0):
        self.name = name.strip()
        self.phone = str(phone).strip()
        self.referrer = referrer.strip()
        self.class_name = class_name.strip()
        self.center = center.strip()
        self.company = company.strip()
        self.special_req = special_req.strip()
        self.raw_index = raw_index  # 原始行号
        
        # 分桌结果
        self.table_num: Optional[int] = None
        self.dinner_table_num: Optional[int] = None

    def __repr__(self):
        return f"{self.name}(推荐人:{self.referrer},班级:{self.class_name},分中心:{self.center})"


def parse_uploaded_file(file_path: str) -> List[Person]:
    """
    解析上传的报名名单文件（Excel或CSV）
    期待的列名：姓名, 手机号, 推荐人, 班级, 分中心, 公司, 特殊要求
    """
    if file_path.endswith('.csv'):
        df = pd.read_csv(file_path, dtype=str)
    else:
        df = pd.read_excel(file_path, dtype=str)
    
    # 标准化列名（去除空格）
    df.columns = [c.strip() for c in df.columns]
    
    # 列名映射（支持多种可能的列名）
    col_map = {}
    name_candidates = ['姓名', '名字', 'name']
    phone_candidates = ['手机号', '手机号码', '电话', 'phone', 'tel', 'mobile']
    referrer_candidates = ['推荐人', '推荐', 'referrer']
    class_candidates = ['班级', '班', 'class', '班级名称']
    center_candidates = ['分中心', '中心', 'center', '分部']
    company_candidates = ['公司', '企业', '单位', 'company', '公司名称']
    special_candidates = ['特殊要求', '备注', '要求', 'note', 'remark', '特殊需求']
    
    for col in df.columns:
        col_lower = col.lower().strip()
        if col in name_candidates or col_lower in [c.lower() for c in name_candidates]:
            col_map['name'] = col
        elif col in phone_candidates or col_lower in [c.lower() for c in phone_candidates]:
            col_map['phone'] = col
        elif col in referrer_candidates or col_lower in [c.lower() for c in referrer_candidates]:
            col_map['referrer'] = col
        elif col in class_candidates or col_lower in [c.lower() for c in class_candidates]:
            col_map['class'] = col
        elif col in center_candidates or col_lower in [c.lower() for c in center_candidates]:
            col_map['center'] = col
        elif col in company_candidates or col_lower in [c.lower() for c in company_candidates]:
            col_map['company'] = col
        elif col in special_candidates or col_lower in [c.lower() for c in special_candidates]:
            col_map['special'] = col
    
    # 必须要有姓名列
    if 'name' not in col_map:
        raise ValueError(f"无法找到'姓名'列，当前列名为: {list(df.columns)}")
    
    persons = []
    for idx, row in df.iterrows():
        name = str(row[col_map['name']]) if pd.notna(row[col_map['name']]) else ''
        if not name or name == 'nan':
            continue  # 跳过空行
        
        phone = str(row[col_map['phone']]) if 'phone' in col_map and pd.notna(row[col_map['phone']]) else ''
        referrer = str(row[col_map['referrer']]) if 'referrer' in col_map and pd.notna(row[col_map['referrer']]) else ''
        class_name = str(row[col_map['class']]) if 'class' in col_map and pd.notna(row[col_map['class']]) else ''
        center = str(row[col_map['center']]) if 'center' in col_map and pd.notna(row[col_map['center']]) else ''
        company = str(row[col_map['company']]) if 'company' in col_map and pd.notna(row[col_map['company']]) else ''
        special = str(row[col_map['special']]) if 'special' in col_map and pd.notna(row[col_map['special']]) else ''
        
        # 清理 'nan' 字符串
        for attr in ['phone', 'referrer', 'class_name', 'center', 'company', 'special']:
            val = locals()[attr]
            if val.lower() == 'nan':
                locals()[attr] = ''
        
        person = Person(
            name=name,
            phone=phone,
            referrer=referrer,
            class_name=class_name,
            center=center,
            company=company,
            special_req=special,
            raw_index=idx
        )
        persons.append(person)
    
    return persons


def assign_tables(persons: List[Person], capacity: int = DEFAULT_TABLE_CAPACITY) -> List[Person]:
    """
    核心分桌算法
    
    规则优先级：
    1. 推荐人相同 → 同一桌
    2. 班级相同 → 同一桌
    3. 分中心相同 → 同一桌
    4. 同一公司 → 同一桌（特殊情况）
    5. 特殊要求 → 同一桌
    
    实现策略：贪心分组 + 局部优化
    """
    if not persons:
        return []
    
    # 复制一份，避免修改原始数据
    result = list(persons)
    
    # ---- 第一步：基于规则构建分组 ----
    # 先按推荐人分组（最高优先级）
    referrer_groups = _group_by_attribute(result, 'referrer')
    
    # 对推荐人组内再按班级分组
    refined_groups = []
    for ref_group in referrer_groups:
        if len(ref_group) <= capacity:
            # 整组可以塞一桌
            refined_groups.append(ref_group)
        else:
            # 超过一桌容量，按班级拆分
            class_groups = _group_by_attribute(ref_group, 'class_name')
            for cg in class_groups:
                if len(cg) <= capacity:
                    refined_groups.append(cg)
                else:
                    # 按分中心再拆分
                    center_groups = _group_by_attribute(cg, 'center')
                    for centg in center_groups:
                        if len(centg) <= capacity:
                            refined_groups.append(centg)
                        else:
                            # 按公司拆分
                            company_groups = _group_by_attribute(centg, 'company')
                            for compg in company_groups:
                                if len(compg) <= capacity:
                                    refined_groups.append(compg)
                                else:
                                    # 按特殊要求拆分
                                    special_groups = _group_by_attribute(compg, 'special_req')
                                    for spg in special_groups:
                                        # 拆分到每桌容量
                                        for i in range(0, len(spg), capacity):
                                            refined_groups.append(spg[i:i+capacity])
    
    # ---- 第二步：将小组合并到满桌 ----
    # 分离出需要合并的小组（人数少于capacity的组）
    full_groups = [g for g in refined_groups if len(g) >= capacity]
    small_groups = [g for g in refined_groups if len(g) < capacity]
    
    # 尝试将小组合并
    merged = _merge_small_groups(small_groups, capacity)
    all_groups = full_groups + merged
    
    # ---- 第三步：分配桌号 ----
    table_num = 1
    for group in all_groups:
        for person in group:
            person.table_num = table_num
        table_num += 1
    
    return result


def assign_dinner_tables(persons: List[Person], capacity: int = DEFAULT_DINNER_CAPACITY) -> List[Person]:
    """
    分配空巴（晚宴）桌号
    空巴桌位更注重交流氛围，按分中心分组为主
    优化：避免出现只有1-2人的"孤儿桌"
    """
    if not persons:
        return []
    
    result = list(persons)
    
    # 按分中心分组
    center_groups = _group_by_attribute(result, 'center')
    
    # 先把大组分拆成<=capacity的子组
    split_groups = []
    for group in center_groups:
        for i in range(0, len(group), capacity):
            split_groups.append(group[i:i+capacity])
    
    # 合并小桌：把人数少于 capacity/2 的桌，合并到其他桌
    # 分离大桌和小桌
    large_groups = [g for g in split_groups if len(g) >= capacity // 2]
    small_groups = [g for g in split_groups if len(g) < capacity // 2]
    
    # 把小桌的人重新分配到已有大桌（尽量保持同分中心）
    for small_group in small_groups:
        # 找同分中心且有空间的大桌
        center = small_group[0].center if small_group else ''
        best_group = None
        for lg in large_groups:
            same_center = all(p.center == center for p in lg)
            if same_center and len(lg) + len(small_group) <= capacity:
                best_group = lg
                break
        
        if best_group:
            best_group.extend(small_group)
        else:
            # 找不到合适的，找任意有空位的大桌
            for lg in large_groups:
                if len(lg) + len(small_group) <= capacity:
                    lg.extend(small_group)
                    break
            else:
                # 所有大桌都放不下，作为独立桌
                large_groups.append(small_group)
    
    # 分配空巴桌号
    table_num = 1
    for group in large_groups:
        for person in group:
            person.dinner_table_num = table_num
        table_num += 1
    
    return result


def _group_by_attribute(persons: List[Person], attr: str) -> List[List[Person]]:
    """按某属性分组，保持组内原始顺序"""
    groups_dict = defaultdict(list)
    no_attr = []
    
    for p in persons:
        val = getattr(p, attr, '')
        if val:
            groups_dict[val].append(p)
        else:
            no_attr.append(p)
    
    result = list(groups_dict.values())
    if no_attr:
        result.append(no_attr)
    
    return result


def _merge_small_groups(small_groups: List[List[Person]], capacity: int) -> List[List[Person]]:
    """将小组合并到满桌"""
    # 按人数从大到小排序
    sorted_groups = sorted(small_groups, key=len, reverse=True)
    
    merged = []
    current_group = []
    
    for group in sorted_groups:
        if len(current_group) + len(group) <= capacity:
            current_group.extend(group)
        else:
            if current_group:
                merged.append(current_group)
            # 如果当前组本身超过容量，拆开
            if len(group) >= capacity:
                for i in range(0, len(group), capacity):
                    merged.append(group[i:i+capacity])
                current_group = []
            else:
                current_group = list(group)
    
    if current_group:
        merged.append(current_group)
    
    return merged


def generate_summary(persons: List[Person]) -> Dict:
    """生成分桌汇总信息"""
    tables = defaultdict(list)
    dinner_tables = defaultdict(list)
    
    for p in persons:
        if p.table_num:
            tables[p.table_num].append(p)
        if p.dinner_table_num:
            dinner_tables[p.dinner_table_num].append(p)
    
    summary = {
        'total_people': len(persons),
        'total_tables': len(tables),
        'total_dinner_tables': len(dinner_tables),
        'tables': {},
        'dinner_tables': {}
    }
    
    for tn, people in sorted(tables.items()):
        summary['tables'][tn] = {
            'count': len(people),
            'members': [p.name for p in people]
        }
    
    for tn, people in sorted(dinner_tables.items()):
        summary['dinner_tables'][tn] = {
            'count': len(people),
            'members': [p.name for p in people]
        }
    
    return summary


def export_to_dataframe(persons: List[Person]) -> pd.DataFrame:
    """将分桌结果导出为DataFrame"""
    data = []
    for p in persons:
        data.append({
            '姓名': p.name,
            '手机号': p.phone,
            '推荐人': p.referrer,
            '班级': p.class_name,
            '分中心': p.center,
            '公司': p.company,
            '特殊要求': p.special_req,
            '桌号': p.table_num or '',
            '空巴桌号': p.dinner_table_num or '',
        })
    return pd.DataFrame(data)
