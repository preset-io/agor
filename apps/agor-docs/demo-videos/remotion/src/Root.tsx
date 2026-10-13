import { Composition } from 'remotion';
import { INTERFACES_SECONDS, Interfaces } from './interfaces/Interfaces';
import { REEL_SECONDS, TeammatesReel } from './Reel';
import { RAISE_SECONDS, RaiseTogether } from './raise/Raise';
import { AiTeammates, DURATION_SECONDS } from './teammates/AiTeammates';
import { AiTeammatesBebop, BEBOP_SECONDS } from './teammates/Bebop';
import { MultiplyThroughput, THROUGHPUT_SECONDS } from './throughput/Throughput';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TeammatesReel"
        component={TeammatesReel}
        durationInFrames={Math.ceil(REEL_SECONDS * 30)}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Interfaces"
        component={Interfaces}
        durationInFrames={Math.ceil(INTERFACES_SECONDS * 30)}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="MultiplyThroughput"
        component={MultiplyThroughput}
        durationInFrames={Math.ceil(THROUGHPUT_SECONDS * 30)}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="RaiseTogether"
        component={RaiseTogether}
        durationInFrames={Math.ceil(RAISE_SECONDS * 30)}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="AiTeammatesBebop"
        component={AiTeammatesBebop}
        durationInFrames={Math.ceil(BEBOP_SECONDS * 30)}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="AiTeammatesGrid"
        component={AiTeammates}
        durationInFrames={Math.ceil(DURATION_SECONDS * 30)}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
