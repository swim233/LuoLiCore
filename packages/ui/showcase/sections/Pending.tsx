import { SectionHead } from '../components/SectionHead';

/* 以后的节：现在只写一行「第 N 步加进来」 */
export function Pending({ title, steps }: { title: string; steps: string }) {
  return (
    <>
      <SectionHead title={title} />
      <div className="sc-pending" data-pending="">
        第 {steps} 步加进来。
      </div>
    </>
  );
}
