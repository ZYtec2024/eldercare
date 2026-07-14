-- 添加address字段到orders表
ALTER TABLE orders ADD COLUMN address VARCHAR(255) DEFAULT NULL;

-- 修改返回的地址字段
-- (如果需要的话，可以在后续中更新约束)
