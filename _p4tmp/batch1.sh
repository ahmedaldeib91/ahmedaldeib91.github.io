#!/bin/bash
cd "C:/Users/MICEOSOF/Desktop/Website/_p4tmp"
mkdir -p logs
for t in t2-sections t3-trainees t4-courses t4b-courses t4c-courses t5-enroll-msg t6-settings-blog; do
  echo "== running $t ==" >> logs/batch1.log
  node $t.mjs > logs/$t.txt 2>&1
  tail -1 logs/$t.txt >> logs/batch1.log
done
echo "BATCH1 DONE" >> logs/batch1.log
