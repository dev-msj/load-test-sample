-- ================================================
-- 스레드/커넥션 풀 튜닝 실습 환경 - 더미 데이터 생성
-- ================================================

USE pool_tuning;

-- 프로시저 삭제 (이미 존재하는 경우)
DROP PROCEDURE IF EXISTS generate_users;
DROP PROCEDURE IF EXISTS generate_products;
DROP PROCEDURE IF EXISTS generate_orders;
DROP PROCEDURE IF EXISTS generate_order_items;
DROP PROCEDURE IF EXISTS generate_all_data;

DELIMITER //

-- ================================================
-- Users 데이터 생성 프로시저 (100,000건)
-- ================================================
CREATE PROCEDURE generate_users(IN num_users INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  DECLARE batch_size INT DEFAULT 1000;

  SET autocommit = 0;

  WHILE i < num_users DO
    INSERT INTO users (email, name, password_hash)
    VALUES (
      CONCAT('user', i, '@example.com'),
      CONCAT('User ', i),
      '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.GQHXnzwN8HQ4Wy'
    );

    SET i = i + 1;

    IF i % batch_size = 0 THEN
      COMMIT;
    END IF;
  END WHILE;

  COMMIT;
  SET autocommit = 1;
END //

-- ================================================
-- Products 데이터 생성 프로시저 (10,000건)
-- ================================================
CREATE PROCEDURE generate_products(IN num_products INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  DECLARE batch_size INT DEFAULT 1000;
  DECLARE cat VARCHAR(20);

  SET autocommit = 0;

  WHILE i < num_products DO
    SET cat = ELT(FLOOR(1 + RAND() * 6), 'Electronics', 'Clothing', 'Books', 'Home', 'Sports', 'Toys');

    INSERT INTO products (name, description, price, stock, category)
    VALUES (
      CONCAT('Product ', i),
      CONCAT('This is the description for product ', i, '. It is a high-quality item in the ', cat, ' category.'),
      ROUND(10 + RAND() * 990, 2),
      FLOOR(RAND() * 1000),
      cat
    );

    SET i = i + 1;

    IF i % batch_size = 0 THEN
      COMMIT;
    END IF;
  END WHILE;

  COMMIT;
  SET autocommit = 1;
END //

-- ================================================
-- Orders 데이터 생성 프로시저 (500,000건)
-- ================================================
CREATE PROCEDURE generate_orders(IN num_orders INT, IN max_user_id INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  DECLARE batch_size INT DEFAULT 5000;
  DECLARE order_status VARCHAR(20);

  SET autocommit = 0;

  WHILE i < num_orders DO
    SET order_status = ELT(FLOOR(1 + RAND() * 5), 'pending', 'processing', 'shipped', 'delivered', 'cancelled');

    INSERT INTO orders (user_id, status, total_amount, order_date)
    VALUES (
      FLOOR(1 + RAND() * max_user_id),
      order_status,
      ROUND(50 + RAND() * 9950, 2),
      DATE_SUB(NOW(), INTERVAL FLOOR(RAND() * 365) DAY)
    );

    -- 인덱스 없는 테이블에도 동일 데이터 삽입
    INSERT INTO orders_no_index (user_id, status, total_amount, order_date)
    VALUES (
      FLOOR(1 + RAND() * max_user_id),
      order_status,
      ROUND(50 + RAND() * 9950, 2),
      DATE_SUB(NOW(), INTERVAL FLOOR(RAND() * 365) DAY)
    );

    SET i = i + 1;

    IF i % batch_size = 0 THEN
      COMMIT;
    END IF;
  END WHILE;

  COMMIT;
  SET autocommit = 1;
END //

-- ================================================
-- Order Items 데이터 생성 프로시저 (약 1,000,000건)
-- ================================================
CREATE PROCEDURE generate_order_items(IN max_order_id INT, IN max_product_id INT)
BEGIN
  DECLARE i INT DEFAULT 1;
  DECLARE batch_size INT DEFAULT 5000;
  DECLARE items_per_order INT;
  DECLARE j INT;

  SET autocommit = 0;

  WHILE i <= max_order_id DO
    -- 각 주문당 1~5개 아이템
    SET items_per_order = FLOOR(1 + RAND() * 5);
    SET j = 0;

    WHILE j < items_per_order DO
      INSERT INTO order_items (order_id, product_id, quantity, unit_price)
      VALUES (
        i,
        FLOOR(1 + RAND() * max_product_id),
        FLOOR(1 + RAND() * 10),
        ROUND(10 + RAND() * 490, 2)
      );
      SET j = j + 1;
    END WHILE;

    SET i = i + 1;

    IF i % batch_size = 0 THEN
      COMMIT;
    END IF;
  END WHILE;

  COMMIT;
  SET autocommit = 1;
END //

-- ================================================
-- 전체 데이터 생성 프로시저
-- ================================================
CREATE PROCEDURE generate_all_data()
BEGIN
  DECLARE start_time DATETIME;
  DECLARE end_time DATETIME;

  SET start_time = NOW();
  SELECT CONCAT('Data generation started at: ', start_time) AS status;

  -- Users 생성 (100,000건)
  SELECT 'Generating 100,000 users...' AS status;
  CALL generate_users(100000);
  SELECT 'Users generation completed.' AS status;

  -- Products 생성 (10,000건)
  SELECT 'Generating 10,000 products...' AS status;
  CALL generate_products(10000);
  SELECT 'Products generation completed.' AS status;

  -- Orders 생성 (500,000건)
  SELECT 'Generating 500,000 orders...' AS status;
  CALL generate_orders(500000, 100000);
  SELECT 'Orders generation completed.' AS status;

  -- Order Items 생성 (약 1,000,000건)
  SELECT 'Generating ~1,000,000 order items...' AS status;
  CALL generate_order_items(500000, 10000);
  SELECT 'Order items generation completed.' AS status;

  SET end_time = NOW();
  SELECT CONCAT('Data generation completed at: ', end_time) AS status;
  SELECT CONCAT('Total time: ', TIMEDIFF(end_time, start_time)) AS duration;

  -- 최종 통계
  SELECT
    (SELECT COUNT(*) FROM users) AS users_count,
    (SELECT COUNT(*) FROM products) AS products_count,
    (SELECT COUNT(*) FROM orders) AS orders_count,
    (SELECT COUNT(*) FROM order_items) AS order_items_count;
END //

DELIMITER ;

-- ================================================
-- 데이터 생성 실행
-- 주의: 약 5~10분 소요될 수 있습니다
-- ================================================
CALL generate_all_data();

SELECT 'Seed data generation completed!' AS message;
