"""
SQLite 数据库模块
存储分桌结果，支持签到查询和更新
"""

import sqlite3
import os
import json
from typing import List, Optional, Dict, Any
from datetime import datetime

DB_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(DB_DIR, 'signin.db')


def get_connection() -> sqlite3.Connection:
    """获取数据库连接"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """初始化数据库表结构"""
    conn = get_connection()
    cursor = conn.cursor()
    
    # 报名人员表（含分桌结果）
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS registrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            referrer TEXT DEFAULT '',
            class_name TEXT DEFAULT '',
            center TEXT DEFAULT '',
            company TEXT DEFAULT '',
            special_req TEXT DEFAULT '',
            table_num INTEGER DEFAULT NULL,
            dinner_table_num INTEGER DEFAULT NULL,
            sign_status TEXT DEFAULT '未签到',
            sign_time TEXT DEFAULT NULL,
            batch_id TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    ''')
    
    # 批次表（每次上传的报名名单为一个批次）
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS batches (
            batch_id TEXT PRIMARY KEY,
            batch_name TEXT DEFAULT '',
            total_people INTEGER DEFAULT 0,
            total_tables INTEGER DEFAULT 0,
            total_dinner_tables INTEGER DEFAULT 0,
            table_capacity INTEGER DEFAULT 10,
            dinner_capacity INTEGER DEFAULT 8,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    ''')
    
    # 创建索引
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_name_phone 
        ON registrations(name, phone)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_batch_id 
        ON registrations(batch_id)
    ''')
    
    conn.commit()
    conn.close()


def import_registrations(persons_list: List[Dict], batch_id: str) -> int:
    """
    导入报名名单到数据库
    persons_list: [{'name':..., 'phone':..., 'table_num':..., 'dinner_table_num':...}, ...]
    返回导入数量
    """
    conn = get_connection()
    cursor = conn.cursor()
    
    count = 0
    for p in persons_list:
        # 检查是否已存在（同姓名+同手机号+同批次）
        cursor.execute(
            'SELECT id FROM registrations WHERE name=? AND phone=? AND batch_id=?',
            (p['name'], p['phone'], batch_id)
        )
        if cursor.fetchone():
            # 更新
            cursor.execute('''
                UPDATE registrations SET
                    referrer=?, class_name=?, center=?, company=?,
                    special_req=?, table_num=?, dinner_table_num=?
                WHERE name=? AND phone=? AND batch_id=?
            ''', (
                p.get('referrer', ''), p.get('class_name', ''), 
                p.get('center', ''), p.get('company', ''),
                p.get('special_req', ''), p.get('table_num', None),
                p.get('dinner_table_num', None),
                p['name'], p['phone'], batch_id
            ))
        else:
            cursor.execute('''
                INSERT INTO registrations 
                (name, phone, referrer, class_name, center, company, 
                 special_req, table_num, dinner_table_num, batch_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                p['name'], p['phone'],
                p.get('referrer', ''), p.get('class_name', ''),
                p.get('center', ''), p.get('company', ''),
                p.get('special_req', ''), p.get('table_num', None),
                p.get('dinner_table_num', None), batch_id
            ))
        count += 1
    
    conn.commit()
    conn.close()
    return count


def save_batch_info(batch_id: str, batch_name: str, total_people: int,
                    total_tables: int, total_dinner_tables: int,
                    table_capacity: int, dinner_capacity: int):
    """保存批次信息"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute('''
        INSERT OR REPLACE INTO batches
        (batch_id, batch_name, total_people, total_tables, total_dinner_tables,
         table_capacity, dinner_capacity)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (batch_id, batch_name, total_people, total_tables, 
          total_dinner_tables, table_capacity, dinner_capacity))
    
    conn.commit()
    conn.close()


def query_person(name: str, phone: str, batch_id: str = '') -> Optional[Dict]:
    """
    查询单个人员信息（用于签到）
    如果 batch_id 为空，则查找最近的批次
    """
    conn = get_connection()
    cursor = conn.cursor()
    
    if batch_id:
        cursor.execute('''
            SELECT * FROM registrations 
            WHERE name=? AND phone=? AND batch_id=?
        ''', (name, phone, batch_id))
    else:
        # 查找所有匹配的记录，按批次时间倒序
        cursor.execute('''
            SELECT r.* FROM registrations r
            WHERE r.name=? AND r.phone=?
            ORDER BY r.id DESC LIMIT 1
        ''', (name, phone))
    
    row = cursor.fetchone()
    conn.close()
    
    if row:
        return dict(row)
    return None


def check_in(name: str, phone: str, batch_id: str = '') -> Optional[Dict]:
    """
    执行签到操作
    返回人员信息（含桌号等），如未找到返回None
    """
    person = query_person(name, phone, batch_id)
    if not person:
        return None
    
    conn = get_connection()
    cursor = conn.cursor()
    
    if person['sign_status'] != '已签到':
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        cursor.execute('''
            UPDATE registrations 
            SET sign_status='已签到', sign_time=?
            WHERE id=?
        ''', (now, person['id']))
        conn.commit()
        person['sign_status'] = '已签到'
        person['sign_time'] = now
    
    conn.close()
    return person


def get_batch_list() -> List[Dict]:
    """获取所有批次列表"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM batches ORDER BY created_at DESC')
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_registrations_by_batch(batch_id: str) -> List[Dict]:
    """获取某批次的所有报名记录"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        'SELECT * FROM registrations WHERE batch_id=? ORDER BY table_num, id',
        (batch_id,)
    )
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_batch_stats(batch_id: str) -> Dict:
    """获取批次签到统计"""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute(
        'SELECT COUNT(*) as total FROM registrations WHERE batch_id=?',
        (batch_id,)
    )
    total = cursor.fetchone()['total']
    
    cursor.execute(
        'SELECT COUNT(*) as signed FROM registrations WHERE batch_id=? AND sign_status="已签到"',
        (batch_id,)
    )
    signed = cursor.fetchone()['signed']
    
    cursor.execute(
        'SELECT COUNT(DISTINCT table_num) as tables FROM registrations WHERE batch_id=? AND table_num IS NOT NULL',
        (batch_id,)
    )
    tables = cursor.fetchone()['tables']
    
    conn.close()
    
    return {
        'total': total,
        'signed': signed,
        'unsigned': total - signed,
        'tables': tables,
        'rate': f"{signed/total*100:.1f}%" if total > 0 else "0%"
    }


def delete_batch(batch_id: str):
    """删除批次及其所有记录"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM registrations WHERE batch_id=?', (batch_id,))
    cursor.execute('DELETE FROM batches WHERE batch_id=?', (batch_id,))
    conn.commit()
    conn.close()
